/** Only the Frame parent boundary is exercised here. Full native UI uses the installed T3 Code browser gate. */
export function aiBoundaryBootstrap({
  workId,
  origin,
  label = "T3 Code boundary fixture",
}) {
  return {
    version: 1,
    workId,
    userScope: "fixture-frame-admin-scope",
    nonce: "fixture-frame-embed-nonce-123456",
    basePath: "/ai/",
    embedPath: `/ai/works/${workId}/`,
    parentOrigin: origin,
    environmentId: "fixture-native-server",
    projectId: "833f299e-49c4-4aeb-a3a3-56f4c5a5a891",
    cwd: "/fixture/work",
    label,
  };
}
export function aiBoundaryHtml(bootstrap) {
  const dto = JSON.stringify(bootstrap).replace(/</g, "\\u003c");
  return `<!doctype html><html><body><p>T3 Code host protocol fixture</p><script>
    const config=${dto},pair=new MessageChannel(),pending=new Map(),fixture={ready:false,attachments:[]};
    const rpc=(op,payload={})=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();pending.set(id,{resolve,reject});pair.port1.postMessage({type:'request',id,op,payload});});
    pair.port1.onmessage=event=>{
      const row=event.data;
      if(row.type==='connected'){fixture.ready=true;void rpc('context.subscribe',{threadId:'fixture-draft-composer',nativeProjectId:config.projectId,cwd:config.cwd,standaloneUrl:'/ai/'}).catch(()=>{});}
      if(row.type==='response'){const next=pending.get(row.id);pending.delete(row.id);row.ok?next?.resolve(row.payload):next?.reject(new Error(row.error.message));}
      if(row.type==='event'&&row.event==='context.attach')fixture.attachments.push(row.payload.item);
      if(row.type==='event'&&row.event==='disposed'){fixture.ready=false;for(const next of pending.values())next.reject(new Error('Frame closed'));pending.clear();}
    };
    pair.port1.start();fixture.context=()=>rpc('context.read');fixture.request=rpc;window.__FRAME_REVIEW_AI__=fixture;
    parent.postMessage({type:'frame-ai-connect',version:1,workId:config.workId,nonce:config.nonce},config.parentOrigin,[pair.port2]);
  </script></body></html>`;
}
