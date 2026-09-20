import { useState } from "react";
import { apiFetch } from "../app-api";
import { PaginatedCollection } from "../shared-ui";

type SetupItem={key:string;identity:string;personId:string|null;displayName:string;department:string;group:string;dates:string[];rowNumbers:number[];conflicts:Array<{date:string;department:string;group:string}>;revision:string|null;transferDate?:string;transferConfirmed?:boolean};
type Options={items:SetupItem[];totalItems:number;people:Array<{id:string;displayName:string;sourceKey:string}>;units:Array<{id:string;name:string;unitType:string;parentId:string|null}>};

export function ImportSetup({batchId,busy,onBusy,onChecked}:{batchId:string;busy:boolean;onBusy:(value:boolean)=>void;onChecked:(report:unknown)=>void}){
  const[options,setOptions]=useState<Options|null>(null);
  const[items,setItems]=useState<SetupItem[]>([]);
  const[error,setError]=useState("");const[confirmed,setConfirmed]=useState(false);const[loading,setLoading]=useState(false);
  async function load(){if(busy||loading)return;onBusy(true);setLoading(true);setError("");try{
    const response=await apiFetch(`/api/imports/batches/${batchId}/setup`);const data=await response.json();
    if(!response.ok)throw new Error(data.message??"资料读取失败");setOptions(data);setItems(data.items);setConfirmed(false);
  }catch(reason){setError(reason instanceof Error?reason.message:"读取失败，请重试");}finally{setLoading(false);onBusy(false);}}
  function update(index:number,patch:Partial<SetupItem>){setItems(current=>current.map((item,i)=>i===index?{...item,...patch}:item));setConfirmed(false);}
  async function save(){if(busy||!confirmed)return;onBusy(true);setError("");try{
    const response=await apiFetch(`/api/imports/batches/${batchId}/setup`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({confirmed:true,items:items.map(({key,personId,displayName,department,group,conflicts,revision,transferDate,transferConfirmed})=>({key,personId,displayName,department,group,...(conflicts.length?{transfer:{effectiveFrom:transferDate,revision,confirmed:transferConfirmed}}:{})}))})});
    const data=await response.json();if(!response.ok)throw new Error(data.message??"保存失败");
    if(data.report)onChecked(data.report);else setError(data.message??"资料已保存，请重新检查文件");
  }catch(reason){setError(reason instanceof Error?reason.message:"连接中断，结果尚未确认。请重新检查文件，避免重复建档。");}finally{onBusy(false);}}
  return <section className="import-setup" aria-label="补齐人员与统计归属" onKeyDown={event=>{if(event.key==="Enter"&&event.target instanceof HTMLInputElement)event.preventDefault();}}>
    <h3>在这里补齐资料，无需退出导入</h3>
    <p>销售助理组长可补齐人员资料，也可核对员工调组后的统计归属。只用于业绩统计，不创建登录账号，不授予管理权限，也不修改已入账业绩。</p>
    {!options?<button type="button" disabled={busy||loading} onClick={load}>{loading?"正在读取…":"核对并补齐人员和归属"}</button>:<>
      <p>共 {items.length} 项待核对。同一人员、同一归属合并处理；只确认文件列出的业务日期，不代表任职起止时间。</p>
      <button type="button" disabled={busy||loading} onClick={load}>重新读取资料</button>
      {options.totalItems>items.length?<p>本批共 {options.totalItems} 项，先处理这 {items.length} 项；保存后可继续处理剩余项，无需重新上传。</p>:null}
      <datalist id="import-departments">{options.units.filter(unit=>unit.unitType==="department").map(unit=><option key={unit.id} value={unit.name}/>)}</datalist>
      <PaginatedCollection items={items} label="待补齐统计资料">{pageItems=>pageItems.map(item=>{const index=items.findIndex(candidate=>candidate.key===item.key);return <fieldset key={item.key} disabled={busy}>
        <legend>{item.identity} · 涉及 {item.rowNumbers.length} 行</legend>
        <details><summary>查看涉及日期与行号</summary><p>日期：{item.dates.join("、")}</p><p>Excel 行号：{item.rowNumbers.join("、")}</p></details>
        {item.conflicts.length?<div className="import-transfer-review">
          <h4>员工已调组？请核对生效日期</h4>
          <p>文件归属：{item.department} / {item.group}。以下日期与系统记录不同：</p>
          <ul>{[...new Set(item.conflicts.map(conflict=>`${conflict.department} / ${conflict.group}`))].map(previous=><li key={previous}>系统归属：{previous}</li>)}</ul>
          <details><summary>查看 {item.conflicts.length} 个冲突日期</summary><p>{item.conflicts.map(conflict=>`${conflict.date}（${conflict.department} / ${conflict.group}）`).join("；")}</p></details>
          <label className="field"><span>调组生效日期</span><input type="date" required value={item.transferDate??""} onChange={event=>update(index,{transferDate:event.target.value,transferConfirmed:false})}/></label>
          <p>例如8月1日调组：7月31日及以前仍归原组；本次文件中8月1日起的业务按新组核对。若文件仍把调组前的业务写在新组，请先改回原组。</p>
          <p>只保存本次文件列出的日期；不会自动补齐其他日期，不改变正式任职、负责人或已入账流水。</p>
          <label className="import-setup-confirm"><input type="checkbox" disabled={!item.transferDate} checked={item.transferConfirmed??false} onChange={event=>update(index,{transferConfirmed:event.target.checked})}/>我确认调组日期和文件归属正确，同意按上述范围保存统计归属</label>
        </div>:null}
        <div className="form-grid">
          <label className="field"><span>对应业务人员</span><select value={item.personId??""} disabled={!!options.items[index]?.personId} onChange={event=>{const person=options.people.find(person=>person.id===event.target.value);update(index,{personId:person?.id??null,displayName:person?.displayName??item.identity});}}><option value="">确认新建人员档案（无登录账号）</option>{options.people.map(person=><option key={person.id} value={person.id}>{person.displayName} · 编号 {person.id}</option>)}</select></label>
          <label className="field"><span>人员姓名</span><input maxLength={100} disabled={!!item.personId} value={item.displayName} onChange={event=>update(index,{displayName:event.target.value})}/></label>
          <label className="field"><span>统计部门</span><input list="import-departments" maxLength={100} readOnly={!!options.items[index]?.department} value={item.department} onChange={event=>update(index,{department:event.target.value})}/></label>
          <label className="field"><span>统计小组</span><input maxLength={100} readOnly={!!options.items[index]?.group} value={item.group} onChange={event=>update(index,{group:event.target.value})}/></label>
        </div>
        <small>表内部门、小组如有填写，须与文件一致；不存在时会建立为统计资料，负责人可后续配置。</small>
      </fieldset>;})}</PaginatedCollection>
      {items.length?<><label className="import-setup-confirm"><input type="checkbox" disabled={busy} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>我已核对人员身份及统计归属；保存资料不等于入账。</label><button type="button" disabled={busy||!confirmed||items.some(item=>!item.displayName.trim()||!item.department.trim()||!item.group.trim()||(item.conflicts.length&&(!item.transferDate||!item.transferConfirmed)))} onClick={save}>{busy?"正在保存并检查…":"保存资料并重新检查"}</button></>:<p>没有待补齐资料，请重新检查文件；其他错误仍需按检查结果处理。</p>}
    </>}
    {error?<p className="form-error" role="alert">{error}</p>:null}
  </section>;
}
