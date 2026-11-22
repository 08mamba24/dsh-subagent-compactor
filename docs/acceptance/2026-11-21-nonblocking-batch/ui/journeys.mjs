import assert from 'node:assert/strict';
import { writeFile, appendFile } from 'node:fs/promises';

export async function run(h, name, resume = false) {
  const {page,bridge,lab,requests,held,until,release,setMode}=h;
  const names={success:'NOINPUT-SUCCESS',failure:'NOINPUT-FAILURE',legacy:'LEGACY-ALL',menu:'NOINPUT-MENU'};
  assert.ok(names[name]);
  const label=names[name]+(['legacy','menu'].includes(name)?'-'+Date.now():'');
  const count=name==='success'?2:1;
  const continueButton=page.getByRole('button',{name:'Continue',exact:true});
  if(await continueButton.count())await continueButton.click();
  if(!resume)setMode('auto');
  const seed=resume?(await bridge('/state')).scenarios.find(s=>s.label===label):await bridge('/seed','POST',{label,count});
  if(!resume)await page.reload();
  await page.getByText(label,{exact:true}).first().click();
  const input=page.locator('[data-composer-input]');
  const command=name==='legacy'?'/subagent-compact all':'/subagent-compact-all';
  setMode('hold');
  if(resume) {
    assert.equal(held.length,count);
  }else if(name==='menu'){
    await input.fill('/subagent-compact-a');
    const option=page.getByRole('option').filter({hasText:'subagent-compact-all'});
    await option.click();
  }else{
    await input.fill(command+(name==='failure'?'   ':''));
    await input.press('Escape');
    await input.press('Enter');
  }
  await until(()=>held.length===count,'all summary requests held');
  await page.waitForTimeout(300);
  let state=await bridge('/state');
  let item=state.scenarios.find(s=>s.label===label);
  const commandRun=item.parent.events.filter(e=>e.type==='command/run');
  assert.equal(commandRun.length,1);
  assert.equal(commandRun[0].data.name,name==='legacy'?'subagent-compact':'subagent-compact-all');
  assert.equal(commandRun[0].data.source.kind,'user');
  assert.equal(item.parent.events.filter(e=>e.type==='command/done').length,0);
  const editable=await input.isEditable();
  if(name!=='legacy')assert.equal(editable,true);
  let draft;
  if(name!=='legacy'){
    await input.pressSequentially('temporary typing');
    await input.press('ControlOrMeta+a');await input.press('Backspace');
    assert.equal((await input.innerText()).trim(),'');
    draft='Draft retained during '+label;
    await page.evaluate(text=>navigator.clipboard.writeText(text),draft);
    await input.press('ControlOrMeta+v');
    await until(async()=>await input.innerText()===draft,'pasted draft');
  }
  const before=await bridge('/state');
  assert.equal(before.scenarios.find(s=>s.label===label).parent.events.filter(e=>e.type==='command/done').length,0);
  const running={name,label,command,editable,draft:await input.innerText(),commandRun,held:held.map(x=>x.row),at:Date.now()};
  await page.screenshot({path:lab+'/screenshots/'+name+'-running.png',fullPage:true});
  await writeFile(lab+'/'+name+'-running.json',JSON.stringify(running,null,2)+'\n');
  const released=release(name==='failure'?'error':'success');assert.equal(released,count);
  item=await until(async()=>{const s=await bridge('/state');const i=s.scenarios.find(x=>x.label===label);return i.parent.events.some(e=>e.type==='command/done')?i:false;},'command done');
  const done=item.parent.events.filter(e=>e.type==='command/done');assert.equal(done.length,1);assert.equal(done[0].data.commandId,commandRun[0].data.commandId);
  assert.equal(done[0].data.kind,name==='failure'?'error':'success');
  if(draft)assert.equal(await input.innerText(),draft);
  assert.equal(await input.isEditable(),true);
  const resultText=done[0].data.text;
  const summary=resultText.split('\n').find(line=>line.startsWith('Summary'));
  await until(async()=> (await page.locator('body').innerText()).includes(summary),'visible result summary');
  const buttons=page.getByRole('button',{name:/subagent-compact/});
  if(await buttons.count())await buttons.last().click();
  await page.screenshot({path:lab+'/screenshots/'+name+'-settled.png',fullPage:true});
  const evidence=await bridge('/evidence');
  const children=seed.childSessionIds.map(id=>({id,records:evidence.disk.find(d=>d.id===id).records}));
  for(const child of children){const summaries=child.records.filter(e=>e.type==='compaction/summary');assert.equal(summaries.length,name==='failure'?0:1);if(summaries.length)assert.equal(summaries[0].data.sourceCommandId,commandRun[0].data.commandId);}
  const result={name,label,seed:{parentSessionId:seed.parentSessionId,childSessionIds:seed.childSessionIds,allInactive:seed.allInactive},running,done:done[0],draftAfter:await input.innerText(),diskSummaries:children.map(c=>({id:c.id,summaries:c.records.filter(e=>e.type==='compaction/summary')})),requests:requests.filter(r=>r.arrivedAt>=running.held[0].arrivedAt),completedAt:Date.now()};
  await writeFile(lab+'/'+name+'-result.json',JSON.stringify(result,null,2)+'\n');
  await appendFile(lab+'/results.jsonl',JSON.stringify({name,kind:done[0].data.kind,commandId:done[0].data.commandId,editableWhilePending:editable,retainedDraft:draft?result.draftAfter===draft:null,summary})+'\n');
  return {name,kind:done[0].data.kind,commandId:done[0].data.commandId,editableWhilePending:editable,retainedDraft:draft?result.draftAfter===draft:null,summary,lab};
}
