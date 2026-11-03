import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import { Pool } from 'pg';
import IORedis from 'ioredis';
import { Queue, Worker, Job } from 'bullmq';
import nodemailer from 'nodemailer';
import { v4 as uuid } from 'uuid';
import { Client as ESClient } from '@elastic/elasticsearch';
import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';

const app = express();
const port = Number(process.env.PORT || 4000);
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgres://reachinbox:reachinbox@localhost:5432/reachinbox' });
const redis = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: null });
const queue = new Queue('email-jobs', { connection: redis });
const es = new ESClient({ node: process.env.ELASTICSEARCH_URL || 'http://localhost:9200' });
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173', credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-only-change-me', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax' } }));

async function init() {
  await pool.query(`CREATE TABLE IF NOT EXISTS emails (
    id UUID PRIMARY KEY, user_id TEXT NOT NULL DEFAULT 'local-user', recipient TEXT NOT NULL,
    subject TEXT NOT NULL, body TEXT NOT NULL, scheduled_at TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled', sender TEXT, sent_at TIMESTAMPTZ,
    error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), idempotency_key TEXT UNIQUE
  )`);
  try { await es.indices.create({ index: 'emails', mappings: { properties: { recipient: {type:'text'}, subject: {type:'text'}, status: {type:'keyword'}, scheduled_at: {type:'date'}, sent_at: {type:'date'} } } }); } catch (e:any) { if (e?.meta?.statusCode !== 400) console.warn('Elasticsearch not ready; search indexing disabled until available.'); }
}
async function indexEmail(row:any) { try { await es.index({ index:'emails', id:row.id, document:{ recipient:row.recipient, subject:row.subject, status:row.status, scheduled_at:row.scheduled_at, sent_at:row.sent_at } }); } catch { /* ES is optional until service is started */ } }

const board = new ExpressAdapter(); board.setBasePath('/admin/queues');
createBullBoard({ queues:[new BullMQAdapter(queue)], serverAdapter:board });
app.use('/admin/queues', board.getRouter());
app.get('/api/health', async (_req, res) => {
  const check = async (task: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout>;

    try {
      await Promise.race([
        task,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timeout')),
            3000
          );
        })
      ]);
      return 'ok';
    } catch {
      return 'unavailable';
    } finally {
      clearTimeout(timer!);
    }
  };

  const [database, redisStatus] = await Promise.all([
    check(pool.query('SELECT 1')),
    check(redis.ping())
  ]);

  res.status(200).json({
    ok: database === 'ok' && redisStatus === 'ok',
    database,
    redis: redisStatus
  });
});
app.get('/api/emails', async (req,res) => { try { const status = String(req.query.status||''); const q = status ? await pool.query('SELECT * FROM emails WHERE status=$1 ORDER BY scheduled_at DESC LIMIT 500',[status]) : await pool.query('SELECT * FROM emails ORDER BY created_at DESC LIMIT 500'); res.json(q.rows); } catch(e:any) { res.status(500).json({error:e.message}); } });
app.post('/api/emails/schedule', async (req,res) => {
  const { recipients, subject, body, startAt, delaySeconds=0, hourlyLimit=100, sender='Ethereal' } = req.body || {};
  if (!Array.isArray(recipients) || !recipients.length || !subject || !body) return res.status(400).json({error:'recipients (array), subject and body are required'});
  const valid = recipients.map((x:any)=>String(x).trim()).filter((x:string)=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  if (!valid.length) return res.status(400).json({error:'No valid recipient email addresses found'});
  const start = startAt ? new Date(startAt) : new Date(); if (Number.isNaN(start.getTime())) return res.status(400).json({error:'Invalid startAt date'});
  const created:any[]=[];
  try {
    for (let i=0;i<valid.length;i++) {
      const id=uuid(); const when=new Date(Math.max(Date.now(),start.getTime()) + i*Math.max(0,Number(delaySeconds)||0)*1000);
      const row=(await pool.query('INSERT INTO emails(id,recipient,subject,body,scheduled_at,sender,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[id,valid[i],String(subject),String(body),when,sender,`${id}`])).rows[0];
      await queue.add('send-email',{emailId:id,hourlyLimit:Number(hourlyLimit)||100},{jobId:id,delay:Math.max(0,when.getTime()-Date.now()), attempts:3, backoff:{type:'exponential',delay:2000}, removeOnComplete:1000, removeOnFail:1000});
      created.push(row); await indexEmail(row);
    }
    res.status(201).json({count:created.length,emails:created});
  } catch(e:any) { res.status(500).json({error:e.message,created:created.length}); }
});
app.get('/api/search', async(req,res)=>{ const q=String(req.query.q||'').trim(); if(!q) return res.json([]); try { const result=await es.search({index:'emails',query:{multi_match:{query:q,fields:['recipient','subject','status']}},size:100}); res.json(result.hits.hits.map((h:any)=>({id:h._id,...h._source}))); } catch { const result=await pool.query('SELECT * FROM emails WHERE recipient ILIKE $1 OR subject ILIKE $1 ORDER BY created_at DESC LIMIT 100',[`%${q}%`]); res.json(result.rows); } });

// Ethereal is a safe test SMTP provider. Create a fresh account automatically if no credentials are supplied.
let transporter: nodemailer.Transporter | null = null;
async function getTransporter() { if (transporter) return transporter; if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) { transporter=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_SECURE==='true',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}}); } else { const test=await nodemailer.createTestAccount(); transporter=nodemailer.createTransport({host:'smtp.ethereal.email',port:587,secure:false,auth:{user:test.user,pass:test.pass}}); console.log('Ethereal test inbox credentials:',test.user,'(password hidden); preview links will appear in logs.'); } return transporter; }
const worker = new Worker('email-jobs', async (job:Job) => {
  const {emailId,hourlyLimit=100}=job.data;
  const got=await pool.query('SELECT * FROM emails WHERE id=$1',[emailId]); if (!got.rowCount) return;
  const email=got.rows[0]; if (email.status==='sent') return;
  // Shared atomic per-hour counter. Release reservation on send failure.
  const hour=Math.floor(Date.now()/3600000); const key=`email-rate:${email.sender||'default'}:${hour}`;
  const count=await redis.incr(key); if(count===1) await redis.expire(key,3700);
  if(count>Math.max(1,Number(hourlyLimit)||100)) { await redis.decr(key); await queue.add('send-email',{...job.data},{jobId:`${emailId}-retry-${hour+1}`,delay:Math.max(1000,(hour+1)*3600000-Date.now()),attempts:3,backoff:{type:'exponential',delay:2000}}); await pool.query("UPDATE emails SET status='scheduled',error=$2 WHERE id=$1",[emailId,'Hourly limit reached; rescheduled']); return; }
  try { await pool.query("UPDATE emails SET status='sending',error=NULL WHERE id=$1",[emailId]); const mailer=await getTransporter(); const info=await mailer.sendMail({from:process.env.MAIL_FROM||'ReachInbox Demo <demo@ethereal.email>',to:email.recipient,subject:email.subject,text:email.body}); const updated=(await pool.query("UPDATE emails SET status='sent',sent_at=NOW(),error=NULL WHERE id=$1 RETURNING *",[emailId])).rows[0]; await indexEmail(updated); const preview=nodemailer.getTestMessageUrl(info); if(preview) console.log(`Ethereal preview for ${email.recipient}: ${preview}`); 
  } catch(e:any) { await redis.decr(key); await pool.query("UPDATE emails SET status='failed',error=$2 WHERE id=$1",[emailId,String(e.message).slice(0,1000)]); throw e; }
},{connection:redis,concurrency:Math.max(1,Number(process.env.WORKER_CONCURRENCY||3))});
worker.on('failed',(job,err)=>console.error('Email job failed',job?.id,err.message));

// Google OAuth: configure credentials in .env and register the callback URL in Google Cloud Console.
app.get('/auth/google', (req,res)=>{ const id=process.env.GOOGLE_CLIENT_ID; if(!id||!process.env.GOOGLE_CLIENT_SECRET) return res.status(501).send('Google OAuth is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to backend/.env.'); const url=new URL('https://accounts.google.com/o/oauth2/v2/auth'); url.searchParams.set('client_id',id); url.searchParams.set('redirect_uri',process.env.GOOGLE_CALLBACK_URL||`http://localhost:${port}/auth/google/callback`); url.searchParams.set('response_type','code'); url.searchParams.set('scope','openid email profile'); url.searchParams.set('access_type','online'); res.redirect(url.toString()); });
app.get('/auth/google/callback',async(req,res)=>{ try { if(!req.query.code) return res.status(400).send('Missing OAuth code'); const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:String(req.query.code),client_id:process.env.GOOGLE_CLIENT_ID||'',client_secret:process.env.GOOGLE_CLIENT_SECRET||'',redirect_uri:process.env.GOOGLE_CALLBACK_URL||`http://localhost:${port}/auth/google/callback`,grant_type:'authorization_code'})}); const tokens:any=await r.json(); if(!r.ok) return res.status(400).json({error:'Google token exchange failed',details:tokens}); const userRes=await fetch('https://www.googleapis.com/oauth2/v3/userinfo',{headers:{authorization:`Bearer ${tokens.access_token}`}}); const user:any=await userRes.json(); (req.session as any).user={id:user.sub,email:user.email,name:user.name,picture:user.picture}; res.redirect(`${process.env.FRONTEND_URL||'http://localhost:5173'}?login=success`); }catch(e:any){res.status(500).send(e.message);} });
app.get('/api/me',(req,res)=>res.json((req.session as any).user||null));
app.post('/auth/logout',(req,res)=>req.session.destroy(()=>res.json({ok:true})));
// Slack OAuth: workspace installation saves bot token in session for this demo; production must persist encrypted per tenant.
app.get('/auth/slack',(req,res)=>{if(!process.env.SLACK_CLIENT_ID||!process.env.SLACK_CLIENT_SECRET)return res.status(501).send('Slack OAuth is not configured. Add SLACK_CLIENT_ID and SLACK_CLIENT_SECRET to backend/.env.');const u=new URL('https://slack.com/oauth/v2/authorize');u.searchParams.set('client_id',process.env.SLACK_CLIENT_ID);u.searchParams.set('scope','chat:write');u.searchParams.set('redirect_uri',process.env.SLACK_REDIRECT_URI||`http://localhost:${port}/auth/slack/callback`);res.redirect(u.toString());});
app.get('/auth/slack/callback',async(req,res)=>{try{const r=await fetch('https://slack.com/api/oauth.v2.access',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:String(req.query.code||''),client_id:process.env.SLACK_CLIENT_ID||'',client_secret:process.env.SLACK_CLIENT_SECRET||'',redirect_uri:process.env.SLACK_REDIRECT_URI||`http://localhost:${port}/auth/slack/callback`})});const data:any=await r.json();if(!data.ok)return res.status(400).json(data);(req.session as any).slackToken=data.access_token;res.redirect(`${process.env.FRONTEND_URL||'http://localhost:5173'}?slack=connected`);}catch(e:any){res.status(500).send(e.message);}});
app.post('/api/slack/test',async(req,res)=>{const token=(req.session as any).slackToken;if(!token)return res.status(401).json({error:'Connect Slack first via /auth/slack'});try{const r=await fetch('https://slack.com/api/chat.postMessage',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({channel:req.body.channel||'#general',text:'ReachInbox demo: Slack notification test.'})});const data=await r.json();res.status(data.ok?200:400).json(data);}catch(e:any){res.status(500).json({error:e.message});}});
app.post('/api/slack/disconnect',(req,res)=>{delete (req.session as any).slackToken;res.json({ok:true});});

init().then(()=>app.listen(port,()=>console.log(`ReachInbox API: http://localhost:${port} | Bull Board: http://localhost:${port}/admin/queues`))).catch(e=>{console.error('Startup failed:',e);process.exit(1)});
