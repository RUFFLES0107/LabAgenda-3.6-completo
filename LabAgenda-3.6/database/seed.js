require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'labagenda.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

const addUser = db.prepare(`INSERT OR IGNORE INTO users(name,email,password_hash,role)
 VALUES(?,?,?,?)`);
addUser.run('Administrador', 'admin@labagenda.local', bcrypt.hashSync('Admin@123', 12), 'admin');
addUser.run('Professor Demonstração', 'professor@labagenda.local', bcrypt.hashSync('Professor@123', 12), 'teacher');

const addEnv = db.prepare(`INSERT OR IGNORE INTO environments(code,name,description) VALUES(?,?,?)`);
[
  ['LAB01','Laboratório de Informática 1','Laboratório escolar de informática'],
  ['LAB02','Laboratório de Informática 2','Laboratório escolar de informática'],
  ['LAB03','Laboratório de Informática 3','Laboratório escolar de informática'],
  ['LAB04','Laboratório de Ciências','Ambiente para atividades de ciências'],
  ['BIB01','Biblioteca','Espaço de leitura e pesquisa']
].forEach(x => addEnv.run(...x));

console.log('Banco inicializado.');
console.log('Administrador local: admin@labagenda.local / Admin@123');
console.log('Professor local: professor@labagenda.local / Professor@123');
console.log('Troque as senhas antes de qualquer publicação pública.');
db.close();
