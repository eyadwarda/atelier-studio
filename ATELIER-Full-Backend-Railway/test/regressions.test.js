const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newDb, DataType } = require('pg-mem');
const Module = require('node:module');
const db = newDb({ noAstCoverageCheck: true });
db.public.registerFunction({ name: 'pg_advisory_xact_lock', args: [DataType.integer], returns: DataType.integer, implementation: () => 1 });
const pg = db.adapters.createPg();
const originalLoad = Module._load;
Module._load = function(id, ...args) { return id === 'pg' ? pg : originalLoad.call(this, id, ...args); };
process.env.JWT_SECRET = 'test-only-secret-with-more-than-32-characters';
process.env.ADMIN_PASSWORD = 'test-only-password';
const { app, pool, initDatabase } = require('../server');
Module._load = originalLoad;
let server;
let base;
let cookie;
async function request(url, options = {}) {
  return fetch(base + url, { ...options, headers: { 'Content-Type': 'application/json', Cookie: cookie || '', ...options.headers } });
}
const project = { id: 'new-project', name: 'New Project', cat: 'Residential', images: ['https://example.com/a.jpg'], featured: true };
after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await pool.end(); });
test('API regression coverage', async t => {
  await initDatabase();
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await t.test('admin requires authentication and accepts valid login', async () => {
    assert.equal((await request('/api/admin/projects')).status, 401);
    const r = await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD }) });
    assert.equal(r.status, 200); cookie = r.headers.get('set-cookie').split(';')[0];
  });
  await t.test('invalid image protocols and malformed project fields are rejected', async () => {
    for (const p of [{...project, images:['javascript:alert(1)']}, {...project, overview:{}}, {...project, id:"bad'id"}]) {
      assert.equal((await request('/api/admin/projects', {method:'POST', body:JSON.stringify(p)})).status, 400);
    }
    assert.equal((await request('/api/admin/projects', {method:'POST', body:JSON.stringify(project)})).status, 201);
  });
  await t.test('project reorder reaches its own handler and persists order', async () => {
    const items = await (await request('/api/admin/projects')).json();
    const ids = items.map(p => p.id).reverse();
    assert.equal((await request('/api/admin/projects/reorder', {method:'PUT', body:JSON.stringify({ids})})).status, 200);
    assert.deepEqual((await (await request('/api/admin/projects')).json()).map(p=>p.id), ids);
    assert.equal((await request('/api/admin/projects/reorder', {method:'PUT', body:JSON.stringify({ids:['missing']})})).status, 400);
  });
  await t.test('database rejections return JSON 500 and server remains healthy', async () => {
    const query=pool.query.bind(pool); pool.query=async()=>{throw new Error('test database failure')};
    try {const r=await request('/api/admin/projects');assert.equal(r.status,500);assert.equal((await r.json()).error.includes('test database'),false);} finally {pool.query=query;}
    assert.equal((await request('/api/health')).status,200);
  });
  await t.test('messages expose older pages with an accurate unread count', async () => {
    for(let i=0;i<55;i++) await pool.query('INSERT INTO contact_messages (name,email,project_type,message) VALUES ($1,$2,$3,$4)', ['Client '+i,'test@example.com','Residential','A test enquiry']);
    const first=await (await request('/api/admin/messages')).json();const second=await (await request('/api/admin/messages?page=2')).json();
    assert.equal(first.messages.length,50);assert.equal(second.messages.length,5);assert.equal(first.total,55);assert.equal(first.unread,55);assert.equal(first.pages,2);
    assert.equal((await request('/api/admin/messages/invalid',{method:'DELETE'})).status,400);
  });
  await t.test('deleting all projects survives application reinitialization', async () => {
    await pool.query('DELETE FROM projects'); await initDatabase();
    assert.deepEqual((await (await request('/api/public')).json()).projects,[]);
  });
  await t.test('invalid JSON returns a controlled 400',async()=>{
    assert.equal((await request('/api/contact',{method:'POST',body:'{'})).status,400);
  });
});

test('public UI regression coverage', async t => {
  const { JSDOM } = require('jsdom');
  const html=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  async function site(projects, hash='') {
    const dom=new JSDOM(html,{url:'https://example.com/'+hash,runScripts:'dangerously',beforeParse(window){window.scrollTo=()=>{};window.fetch=async()=>({ok:true,json:async()=>({projects,settings:{}})});}});
    await new Promise(resolve=>setImmediate(resolve));
    return dom;
  }
  await t.test('stored HTML is rendered as text and dangerous URLs are stripped',async()=>{
    const dom=await site([{...project,name:'<img src=x onerror="alert(1)">',overview:'<svg onload="alert(1)">',source:'javascript:alert(1)'}]);
    const doc=dom.window.document;assert.equal(doc.querySelector('.card-name').textContent,'<img src=x onerror="alert(1)">');
    assert.equal(doc.querySelector('.card-name img'),null);
    doc.querySelector('[data-project]').click();
    assert.equal(doc.querySelector('#detailContent svg'),null);
    assert.equal(doc.querySelector('.project-credit a').getAttribute('href'),'');
    dom.window.close();
  });
  await t.test('empty API list does not display built-in sample projects',async()=>{
    const dom=await site([]);assert.equal(dom.window.document.querySelectorAll('#featuredGrid .project-card').length,0);dom.window.close();
  });
  await t.test('direct links resolve newly loaded projects and navigation updates URL',async()=>{
    const dom=await site([project],'#project-new-project');const doc=dom.window.document;
    assert.equal(doc.querySelector('#detailContent h1').textContent,'New Project');
    doc.querySelector('.nav-links [data-page="projects"]').click();assert.equal(dom.window.location.hash,'#projects');dom.window.close();
  });
  await t.test('malformed URL hashes render a controlled missing-page view',async()=>{
    const dom=await site([project],'#project-%E0%A4%A');assert.equal(dom.window.document.querySelector('#page-404').classList.contains('active'),true);dom.window.close();
  });
});
