const net=require('net'),fs=require('fs'),crypto=require('crypto');
const ep=JSON.parse(fs.readFileSync(process.env.USERPROFILE+'/.workbuddy/wbipc/endpoint.json','utf8'));
const PIPE=ep.endpoint,TICKET=ep.ticket;
const b64u=b=>Buffer.from(b).toString('base64url');
const tid=t=>crypto.createHash('sha256').update(t,'utf8').digest('hex').slice(0,16);
function enc(role,t){const ps=[role==='server'?'wbipc-s':'wbipc-c',String(t.protocol),t.endpoint,t.clientNonce,t.serverNonce];const bs=[];for(const p of ps){const b=Buffer.from(p,'utf8');const l=Buffer.alloc(4);l.writeUInt32BE(b.length,0);bs.push(l,b);}return Buffer.concat(bs);}
const proof=(tk,r,t)=>crypto.createHmac('sha256',Buffer.from(tk,'utf8')).update(enc(r,t)).digest('base64url');
function probe(kind){return new Promise(res=>{
  const s=net.createConnection(PIPE);let buf='',nonce='';let done=false;
  const fin=v=>{if(done)return;done=true;try{s.destroy()}catch{};res(v);};
  s.setTimeout(3000,()=>fin({kind,err:'timeout'}));
  s.on('error',e=>fin({kind,err:e.code}));
  s.on('connect',()=>{nonce=b64u(crypto.randomBytes(16));s.write(JSON.stringify({type:'session_hello',protocol_min:1,protocol_max:1,client_nonce:nonce,ticket_id:tid(TICKET),client:{kind,id:'probe',version:'0'}})+'\n');});
  s.on('data',d=>{buf+=d.toString();let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);if(!l.trim())continue;let m;try{m=JSON.parse(l)}catch{continue}
    if(m.type==='session_challenge'){const t={protocol:1,endpoint:PIPE,clientNonce:nonce,serverNonce:m.server_nonce};s.write(JSON.stringify({type:'session_prove',client_proof:proof(TICKET,'client',t)})+'\n');}
    else if(m.type==='session_hello_ack'){fin({kind,pipes:m.pipes});}
    else if(m.type==='session_hello_error'){fin({kind,err:m.code});}
  }});
});}
(async()=>{for(const k of ['renderer','desktop','cli','main','app','ui','trusted','codebuddy']){const r=await probe(k);console.log(JSON.stringify(r));}})();
