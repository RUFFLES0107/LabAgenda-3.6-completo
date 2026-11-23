require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'DEV_ONLY_CHANGE_THIS_SECRET_BEFORE_DEPLOYMENT_36';
const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(__dirname, '..', '..', 'database', 'labagenda.sqlite');
fs.mkdirSync(path.dirname(dbPath), {recursive:true});
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'database', 'schema.sql'), 'utf8'));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({limit:'1mb'}));

const nowISO = () => new Date().toISOString();
const audit = (actor, type, id, action, details={}) =>
  db.prepare(`INSERT INTO audit_logs(actor_id,entity_type,entity_id,action,details) VALUES(?,?,?,?,?)`)
    .run(actor || null, type, id || null, action, JSON.stringify(details));
const notify = (userId,title,message,type='booking',id=null) =>
  db.prepare(`INSERT INTO notifications(user_id,title,message,related_entity_type,related_entity_id) VALUES(?,?,?,?,?)`)
    .run(userId,title,message,type,id);
const isAdmin = u => u && u.role === 'admin';
function auth(req,res,next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i,'');
  if (!token) return res.status(401).json({error:'Faça login para continuar.'});
  try {
    const data = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id,name,email,role,active FROM users WHERE id=?').get(data.id);
    if (!user || !user.active) return res.status(401).json({error:'Conta indisponível.'});
    req.user = user; next();
  } catch { return res.status(401).json({error:'Sessão inválida. Entre novamente.'}); }
}
function admin(req,res,next) {
  if (!isAdmin(req.user)) return res.status(403).json({error:'Acesso exclusivo do administrador.'});
  next();
}
function fail(res, err) { return res.status(err.status || 400).json({error:err.message || 'Não foi possível concluir a operação.'}); }
function validateLesson(x) {
  if (!x || !/^\d{4}-\d{2}-\d{2}$/.test(x.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x.end)) throw new Error('Informe data e horários válidos.');
  const d = new Date(`${x.date}T12:00:00`);
  if (Number.isNaN(d.getTime()) || d.getDay()===0 || d.getDay()===6) throw new Error('Agendamentos somente de segunda a sexta-feira.');
  const [sh,sm]=x.start.split(':').map(Number), [eh,em]=x.end.split(':').map(Number);
  if ((eh*60+em)-(sh*60+sm)!==50) throw new Error('Cada aula deve ter duração de 50 minutos.');
  if (x.start < '07:20' || x.end > '18:15' || (x.start < '10:05' && x.end > '09:50') || (x.start < '15:45' && x.end > '15:30')) throw new Error('Horário fora da grade escolar ou em intervalo.');
  const dayStart = new Date(`${x.date}T00:00:00`);
  const min = new Date(Date.now()+24*60*60*1000);
  const max = new Date(Date.now()+7*24*60*60*1000);
  const dateOnly = new Date(`${x.date}T23:59:59`);
  if (dateOnly < min || dayStart > max) throw new Error('A solicitação deve respeitar antecedência mínima de 24 horas e máxima de 7 dias.');
}
function holidayFor(date) {
  return db.prepare('SELECT * FROM holidays WHERE start_date<=? AND end_date>=? LIMIT 1').get(date,date);
}
function overlap(envId, lesson, excludeIds=[]) {
  const params=[envId,lesson.date,lesson.end,lesson.start];
  let sql=`SELECT bl.id, bl.booking_id, b.status FROM booking_lessons bl
    JOIN bookings b ON b.id=bl.booking_id
    WHERE b.environment_id=? AND bl.lesson_date=? AND bl.status='active'
    AND b.status IN ('pending','approved','partially_cancelled')
    AND bl.start_time < ? AND bl.end_time > ?`;
  const rows=db.prepare(sql).all(...params);
  return rows.filter(r=>!excludeIds.includes(r.id));
}
function expirePending() {
  const pending=db.prepare(`SELECT b.id,b.teacher_id,MIN(bl.lesson_date||'T'||bl.start_time) AS first_start
    FROM bookings b JOIN booking_lessons bl ON bl.booking_id=b.id
    WHERE b.status='pending' GROUP BY b.id`).all();
  const tx=db.transaction(()=>{
    for(const b of pending){
      const created=db.prepare('SELECT created_at FROM bookings WHERE id=?').get(b.id).created_at;
      const expiresAt=Math.min(new Date(created.replace(' ','T')+'Z').getTime()+24*3600000,
        new Date(b.first_start+':00').getTime()-3600000);
      if(Date.now()>=expiresAt){
        db.prepare(`UPDATE bookings SET status='cancelled' WHERE id=?`).run(b.id);
        audit(null,'booking',b.id,'automatic_expiration',{reason:'Prazo de validade atingido'});
        notify(b.teacher_id,'Solicitação expirada',`A solicitação #${b.id} expirou e os horários foram liberados.`);
      }
    }
  });
  tx();
}
setInterval(()=>{ try{expirePending();}catch(e){console.error('Falha na expiração:',e.message);} },60*1000);
expirePending();

app.get('/api/health',(req,res)=>res.json({status:'ok',application:'LabAgenda',version:'3.6.0'}));
app.post('/api/auth/login',(req,res)=>{
  const {email,password}=req.body||{};
  const user=db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE AND active=1').get(String(email||'').trim());
  if(!user || !bcrypt.compareSync(String(password||''),user.password_hash)) return res.status(401).json({error:'E-mail ou senha incorretos.'});
  const token=jwt.sign({id:user.id},JWT_SECRET,{expiresIn:'8h'});
  res.json({token,user:{id:user.id,name:user.name,email:user.email,role:user.role}});
});
app.get('/api/me',auth,(req,res)=>res.json(req.user));
app.post('/api/auth/change-password',auth,(req,res)=>{
  const {currentPassword,newPassword}=req.body||{};
  const row=db.prepare('SELECT password_hash FROM users WHERE id=?').get(req.user.id);
  if(!bcrypt.compareSync(String(currentPassword||''),row.password_hash)) return res.status(400).json({error:'Senha atual incorreta.'});
  if(!newPassword || String(newPassword).length<8) return res.status(400).json({error:'A nova senha deve ter pelo menos 8 caracteres.'});
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(String(newPassword),12),req.user.id);
  audit(req.user.id,'user',req.user.id,'password_changed');
  res.json({message:'Senha alterada com sucesso.'});
});

app.get('/api/dashboard',auth,(req,res)=>{
  const own=req.user.role==='teacher'?'WHERE teacher_id=?':'';
  const args=req.user.role==='teacher'?[req.user.id]:[];
  const counts=db.prepare(`SELECT status,COUNT(*) total FROM bookings ${own} GROUP BY status`).all(...args);
  const environments=db.prepare('SELECT COUNT(*) total FROM environments WHERE active=1').get().total;
  res.json({counts,environments});
});
app.get('/api/environments',auth,(req,res)=>res.json(db.prepare('SELECT * FROM environments WHERE active=1 ORDER BY code').all()));
app.post('/api/environments',auth,admin,(req,res)=>{
  try{
    const {code,name,description=''}=req.body||{};
    if(!code||!name) throw new Error('Código e nome são obrigatórios.');
    const info=db.prepare('INSERT INTO environments(code,name,description) VALUES(?,?,?)').run(String(code).trim().toUpperCase(),String(name).trim(),String(description));
    audit(req.user.id,'environment',info.lastInsertRowid,'created',{code,name});
    res.status(201).json({id:info.lastInsertRowid});
  }catch(e){fail(res,e);}
});
app.get('/api/bookings',auth,(req,res)=>{
  const where=req.user.role==='teacher'?'WHERE b.teacher_id=?':'';
  const rows=db.prepare(`SELECT b.*,u.name teacher_name,e.code environment_code,e.name environment_name
    FROM bookings b JOIN users u ON u.id=b.teacher_id JOIN environments e ON e.id=b.environment_id
    ${where} ORDER BY b.created_at DESC`).all(...(req.user.role==='teacher'?[req.user.id]:[]));
  const lessons=db.prepare('SELECT * FROM booking_lessons WHERE booking_id=? ORDER BY lesson_date,start_time');
  res.json(rows.map(b=>({...b,lessons:lessons.all(b.id)})));
});
app.post('/api/bookings',auth,(req,res)=>{
  try{
    const {environmentId,lessons}=req.body||{};
    if(!Array.isArray(lessons)||lessons.length<1||lessons.length>12) throw new Error('Selecione de 1 a 12 aulas.');
    const env=db.prepare('SELECT * FROM environments WHERE id=? AND active=1').get(Number(environmentId));
    if(!env) throw new Error('Ambiente inválido.');
    const normalized=lessons.map(x=>({date:x.date,start:x.start,end:x.end}));
    normalized.forEach(validateLesson);
    const keys=new Set();
    for(const l of normalized){
      const k=`${l.date}|${l.start}`;
      if(keys.has(k)) throw new Error('Existem aulas repetidas na solicitação.');
      keys.add(k);
      if(holidayFor(l.date)) throw new Error('A data selecionada possui feriado ou recesso cadastrado.');
      if(overlap(env.id,l).length) throw new Error('Um ou mais horários já estão ocupados ou aguardam aprovação.');
    }
    const tx=db.transaction(()=>{
      const info=db.prepare(`INSERT INTO bookings(teacher_id,environment_id,status) VALUES(?,?,'pending')`).run(req.user.id,env.id);
      const add=db.prepare('INSERT INTO booking_lessons(booking_id,lesson_date,start_time,end_time) VALUES(?,?,?,?)');
      normalized.forEach(l=>add.run(info.lastInsertRowid,l.date,l.start,l.end));
      audit(req.user.id,'booking',info.lastInsertRowid,'created',{environment:env.code,lessons:normalized});
      const admins=db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all();
      admins.forEach(a=>notify(a.id,'Nova solicitação',`${req.user.name} enviou a solicitação #${info.lastInsertRowid}.`));
      return info.lastInsertRowid;
    });
    res.status(201).json({id:tx(),message:'Solicitação enviada para aprovação.'});
  }catch(e){fail(res,e);}
});
app.post('/api/bookings/:id/approve',auth,admin,(req,res)=>{
  try{
    const id=Number(req.params.id), b=db.prepare("SELECT * FROM bookings WHERE id=? AND status='pending'").get(id);
    if(!b) throw new Error('Solicitação pendente não encontrada.');
    const tx=db.transaction(()=>{
      db.prepare("UPDATE bookings SET status='approved',decided_at=CURRENT_TIMESTAMP,decided_by=? WHERE id=?").run(req.user.id,id);
      audit(req.user.id,'booking',id,'approved');
      notify(b.teacher_id,'Agendamento aprovado',`Sua solicitação #${id} foi aprovada.`);
    }); tx(); res.json({message:'Solicitação aprovada.'});
  }catch(e){fail(res,e);}
});
app.post('/api/bookings/:id/reject',auth,admin,(req,res)=>{
  try{
    const id=Number(req.params.id), reason=String(req.body?.reason||'').trim();
    if(!reason) throw new Error('A justificativa da rejeição é obrigatória.');
    const b=db.prepare("SELECT * FROM bookings WHERE id=? AND status='pending'").get(id);
    if(!b) throw new Error('Solicitação pendente não encontrada.');
    const tx=db.transaction(()=>{
      db.prepare("UPDATE bookings SET status='rejected',rejection_reason=?,decided_at=CURRENT_TIMESTAMP,decided_by=? WHERE id=?").run(reason,req.user.id,id);
      audit(req.user.id,'booking',id,'rejected',{reason});
      notify(b.teacher_id,'Agendamento rejeitado',`Solicitação #${id} rejeitada. Motivo: ${reason}`);
    }); tx(); res.json({message:'Solicitação rejeitada.'});
  }catch(e){fail(res,e);}
});
app.post('/api/bookings/:id/cancel',auth,(req,res)=>{
  try{
    const id=Number(req.params.id), b=db.prepare('SELECT * FROM bookings WHERE id=?').get(id);
    if(!b) throw new Error('Reserva não encontrada.');
    if(req.user.role!=='admin' && b.teacher_id!==req.user.id) throw Object.assign(new Error('Você só pode cancelar suas próprias reservas.'),{status:403});
    if(!['pending','approved','partially_cancelled'].includes(b.status)) throw new Error('Esta solicitação não pode ser cancelada.');
    const reason=String(req.body?.reason||'').trim();
    const selected=Array.isArray(req.body?.lessonIds)?req.body.lessonIds.map(Number):[];
    const lessons=db.prepare("SELECT * FROM booking_lessons WHERE booking_id=? AND status='active'").all(id);
    if(b.status==='pending' && selected.length) throw new Error('Cancelamento parcial de solicitação pendente não é permitido.');
    const targets=selected.length?lessons.filter(l=>selected.includes(l.id)):lessons;
    if(!targets.length) throw new Error('Selecione aulas válidas para cancelar.');
    const exceptional=req.user.role==='admin' && targets.some(l=>new Date(`${l.lesson_date}T${l.start_time}:00`)-Date.now()<24*3600000);
    if(exceptional && !reason) throw new Error('Justificativa obrigatória para cancelamento administrativo excepcional.');
    if(!exceptional && targets.some(l=>new Date(`${l.lesson_date}T${l.start_time}:00`)-Date.now()<24*3600000)) throw new Error('O cancelamento normal exige 24 horas de antecedência para cada aula.');
    if(selected.length && b.status!=='approved' && b.status!=='partially_cancelled') throw new Error('Cancelamento parcial somente em reservas aprovadas.');
    const tx=db.transaction(()=>{
      const upd=db.prepare("UPDATE booking_lessons SET status='cancelled' WHERE id=? AND booking_id=?");
      targets.forEach(l=>upd.run(l.id,id));
      const remaining=lessons.length-targets.length;
      const status=remaining===0?'cancelled':'partially_cancelled';
      db.prepare('UPDATE bookings SET status=? WHERE id=?').run(status,id);
      audit(req.user.id,'booking',id,'cancelled',{lessonIds:targets.map(l=>l.id),reason,exceptional});
      notify(b.teacher_id,'Reserva cancelada',`A reserva #${id} foi atualizada por cancelamento.`);
    }); tx(); res.json({message:'Cancelamento registrado.'});
  }catch(e){fail(res,e);}
});

app.get('/api/holidays',auth,(req,res)=>res.json(db.prepare('SELECT * FROM holidays ORDER BY start_date').all()));
app.post('/api/holidays',auth,admin,(req,res)=>{
  try{
    const {name,startDate,endDate,type}=req.body||{};
    if(!name||!startDate||!endDate||!['holiday','recess'].includes(type)||startDate>endDate) throw new Error('Preencha nome, período e tipo corretamente.');
    const tx=db.transaction(()=>{
      const info=db.prepare('INSERT INTO holidays(name,start_date,end_date,type) VALUES(?,?,?,?)').run(name,startDate,endDate,type);
      audit(req.user.id,'holiday',info.lastInsertRowid,'created',{name,startDate,endDate,type});
      const affected=db.prepare(`SELECT DISTINCT b.id,b.teacher_id FROM bookings b JOIN booking_lessons bl ON bl.booking_id=b.id
        WHERE b.status='approved' AND bl.status='active' AND bl.lesson_date BETWEEN ? AND ?`).all(startDate,endDate);
      const admins=db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all();
      affected.forEach(b=>admins.forEach(a=>notify(a.id,'Reserva afetada por calendário',`A reserva #${b.id} foi identificada no período cadastrado.`, 'booking',b.id)));
      return {id:info.lastInsertRowid,affected:affected.length};
    });
    res.status(201).json(tx());
  }catch(e){fail(res,e);}
});
app.get('/api/affected-bookings',auth,admin,(req,res)=>{
  const rows=db.prepare(`SELECT DISTINCT b.*,u.name teacher_name,e.name environment_name,e.code environment_code
    FROM bookings b JOIN booking_lessons bl ON bl.booking_id=b.id JOIN users u ON u.id=b.teacher_id
    JOIN environments e ON e.id=b.environment_id JOIN holidays h ON bl.lesson_date BETWEEN h.start_date AND h.end_date
    WHERE b.status='approved' AND bl.status='active' ORDER BY b.id DESC`).all();
  res.json(rows.map(b=>({...b,lessons:db.prepare(`SELECT bl.* FROM booking_lessons bl JOIN holidays h ON bl.lesson_date BETWEEN h.start_date AND h.end_date WHERE bl.booking_id=? AND bl.status='active'`).all(b.id),
    decisions:db.prepare('SELECT * FROM admin_decisions WHERE booking_id=? ORDER BY created_at DESC').all(b.id)})));
});
app.post('/api/affected-bookings/:id/decision',auth,admin,(req,res)=>{
  try{
    const id=Number(req.params.id),{decision,notes=''}=req.body||{};
    if(!['maintain','cancel','reorganize'].includes(decision)) throw new Error('Decisão inválida.');
    const b=db.prepare("SELECT * FROM bookings WHERE id=? AND status='approved'").get(id);
    if(!b) throw new Error('Reserva aprovada não encontrada.');
    if(decision==='reorganize') throw new Error('Use a ação de reorganização para informar as novas datas e horários.');
    db.prepare('INSERT INTO admin_decisions(booking_id,administrator_id,decision,notes) VALUES(?,?,?,?)').run(id,req.user.id,decision,String(notes));
    audit(req.user.id,'booking',id,'administrative_decision',{decision,notes});
    if(decision==='maintain') res.json({message:'Decisão de manter registrada. A reserva não foi alterada.'});
    else res.json({message:'Decisão de cancelar registrada no histórico. O cancelamento NÃO foi executado enquanto PD-09 estiver pendente.'});
  }catch(e){fail(res,e);}
});
app.post('/api/affected-bookings/:id/reorganize',auth,admin,(req,res)=>{
  try{
    const id=Number(req.params.id),{lessonIds,environmentId,lessons,notes=''}=req.body||{};
    const b=db.prepare("SELECT * FROM bookings WHERE id=? AND status='approved'").get(id);
    if(!b) throw new Error('Reserva aprovada não encontrada.');
    if(!Array.isArray(lessonIds)||!lessonIds.length||!Array.isArray(lessons)||lessonIds.length!==lessons.length) throw new Error('Selecione as aulas afetadas e informe os novos horários correspondentes.');
    const chosen=db.prepare(`SELECT bl.* FROM booking_lessons bl JOIN holidays h ON bl.lesson_date BETWEEN h.start_date AND h.end_date
      WHERE bl.booking_id=? AND bl.status='active' AND bl.id IN (${lessonIds.map(()=>'?').join(',')})`).all(id,...lessonIds.map(Number));
    if(chosen.length!==lessonIds.length) throw new Error('Somente aulas efetivamente afetadas podem ser reorganizadas.');
    const env=db.prepare('SELECT * FROM environments WHERE id=? AND active=1').get(Number(environmentId||b.environment_id));
    if(!env) throw new Error('Ambiente inválido.');
    const normalized=lessons.map(x=>({date:x.date,start:x.start,end:x.end}));
    normalized.forEach(l=>{
      if(!/^\d{4}-\d{2}-\d{2}$/.test(l.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(l.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(l.end)) throw new Error('Data ou horário inválido.');
      const d=new Date(`${l.date}T12:00:00`); if(d.getDay()===0||d.getDay()===6) throw new Error('Agendamentos somente de segunda a sexta.');
      if((Number(l.end.slice(0,2))*60+Number(l.end.slice(3)))-(Number(l.start.slice(0,2))*60+Number(l.start.slice(3)))!==50) throw new Error('Cada aula deve durar 50 minutos.');
      if(l.start<'07:20'||l.end>'18:15'||(l.start<'10:05'&&l.end>'09:50')||(l.start<'15:45'&&l.end>'15:30')) throw new Error('Horário fora da grade ou em intervalo.');
      if(holidayFor(l.date)) throw new Error('A nova data também possui feriado ou recesso.');
    });
    const ids=chosen.map(x=>x.id);
    normalized.forEach(l=>{if(overlap(env.id,l,ids).length) throw new Error('Conflito com outra reserva ou solicitação pendente válida.');});
    for(let i=0;i<normalized.length;i++) for(let j=i+1;j<normalized.length;j++){
      const a=normalized[i],c=normalized[j];
      if(a.date===c.date&&a.start<c.end&&a.end>c.start) throw new Error('As aulas reorganizadas conflitam entre si.');
    }
    const before=chosen;
    const tx=db.transaction(()=>{
      db.prepare(`UPDATE booking_lessons SET status='cancelled' WHERE id IN (${ids.map(()=>'?').join(',')})`).run(...ids);
      const add=db.prepare("INSERT INTO booking_lessons(booking_id,lesson_date,start_time,end_time,status) VALUES(?,?,?,?, 'active')");
      normalized.forEach(l=>add.run(id,l.date,l.start,l.end));
      db.prepare('UPDATE bookings SET environment_id=? WHERE id=?').run(env.id,id);
      db.prepare('INSERT INTO admin_decisions(booking_id,administrator_id,decision,notes) VALUES(?,?,?,?)').run(id,req.user.id,'reorganize',String(notes));
      audit(req.user.id,'booking',id,'reorganized',{before,after:normalized,environmentId:env.id});
      notify(b.teacher_id,'Reserva reorganizada',`A reserva #${id} foi reorganizada pelo administrador.`);
    }); tx(); res.json({message:'Reserva reorganizada com sucesso.'});
  }catch(e){fail(res,e);}
});
app.get('/api/notifications',auth,(req,res)=>res.json(db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.id)));
app.post('/api/notifications/:id/read',auth,(req,res)=>{
  db.prepare('UPDATE notifications SET read_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?').run(Number(req.params.id),req.user.id);
  res.json({message:'Notificação atualizada.'});
});
app.get('/api/history',auth,admin,(req,res)=>res.json(db.prepare(`SELECT a.*,u.name actor_name FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 200`).all()));
app.get('/api/reports',auth,admin,(req,res)=>{
  const byEnv=db.prepare(`SELECT e.code,e.name,COUNT(DISTINCT b.id) bookings FROM environments e LEFT JOIN bookings b ON b.environment_id=e.id GROUP BY e.id ORDER BY e.code`).all();
  const byStatus=db.prepare('SELECT status,COUNT(*) total FROM bookings GROUP BY status').all();
  res.json({byEnv,byStatus});
});
app.get('/api/users',auth,admin,(req,res)=>res.json(db.prepare('SELECT id,name,email,role,active,created_at FROM users ORDER BY name').all()));
app.post('/api/users',auth,admin,(req,res)=>{
  try{
    const {name,email,password,role}=req.body||{};
    if(!name||!email||!password||!['admin','teacher'].includes(role)||String(password).length<8) throw new Error('Informe nome, e-mail, perfil e senha com pelo menos 8 caracteres.');
    const info=db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES(?,?,?,?)').run(name,String(email).toLowerCase(),bcrypt.hashSync(password,12),role);
    audit(req.user.id,'user',info.lastInsertRowid,'created',{name,email,role});
    res.status(201).json({id:info.lastInsertRowid});
  }catch(e){fail(res,e);}
});
app.patch('/api/users/:id/status',auth,admin,(req,res)=>{
  const active=req.body?.active?1:0;
  if(Number(req.params.id)===req.user.id&&!active) return res.status(400).json({error:'Não é possível desativar a própria conta.'});
  db.prepare('UPDATE users SET active=? WHERE id=?').run(active,Number(req.params.id));
  audit(req.user.id,'user',Number(req.params.id),'status_changed',{active});
  res.json({message:'Status atualizado.'});
});

app.use('/api',(req,res)=>res.status(404).json({error:'Rota não encontrada.'}));
app.use(express.static(path.join(__dirname,'..','..','frontend')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'..','..','frontend','index.html')));
app.listen(PORT,()=>console.log(`LabAgenda 3.6 disponível em http://localhost:${PORT}`));
