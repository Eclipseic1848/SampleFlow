import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, FileUp, PauseCircle, PlayCircle, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import { apiFetch, businessDateToday, downloadApiFile, eventTypeName, formatMoney, formatOperationTime, readResponseJson } from "../app-api";
import type { AccountingCorrection, AccountingPeriod, HistoricalReview, Order, OrderFilters, OrderLifecycle, PerformanceEvent, User } from "../app-types";
import { Field, Modal, PaginatedCollection, Pagination, Status, confirmDiscard, parsePageNumber, parsePageSize, type PageSize } from "../shared-ui";

const emptyOrderFilters:OrderFilters={search:"",month:"",status:"",salesperson:"",department:"",group:"",region:"",customerUnit:""};
const orderFilterUrlKeys:Record<keyof OrderFilters,string>={search:"orderSearch",month:"orderMonth",status:"orderStatus",salesperson:"orderSalesperson",department:"orderDepartment",group:"orderGroup",region:"orderRegion",customerUnit:"orderCustomerUnit"};
function readOrderUrlState(){const params=new URLSearchParams(window.location.search);const filters={...emptyOrderFilters};for(const key of Object.keys(orderFilterUrlKeys) as Array<keyof OrderFilters>)filters[key]=params.get(orderFilterUrlKeys[key])??"";return{filters,page:parsePageNumber(params.get("orderPage")),pageSize:parsePageSize(params.get("orderPageSize")),snapshot:params.get("orderSnapshot")};}
function writeOrderUrlState(filters:OrderFilters,page:number,pageSize:PageSize,mode:"push"|"replace"="push",snapshot?:string|null){const params=new URLSearchParams(window.location.search);params.set("page","orders");for(const key of Object.keys(orderFilterUrlKeys) as Array<keyof OrderFilters>){if(filters[key])params.set(orderFilterUrlKeys[key],filters[key]);else params.delete(orderFilterUrlKeys[key]);}params.delete("orderCursor");if(snapshot===null)params.delete("orderSnapshot");else if(snapshot!==undefined)params.set("orderSnapshot",snapshot);params.set("orderPage",String(page));params.set("orderPageSize",String(pageSize));window.history[mode==="push"?"pushState":"replaceState"]({},"",`${window.location.pathname}?${params.toString()}${window.location.hash}`);}

export function OrdersPage({ user }: { user: User }) {
  const canEdit=user.capabilities.editPerformance;
  const canExport=user.capabilities.exportPerformance;
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<Order | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const initialUrlState=useRef(readOrderUrlState()).current;
  const [draftFilters,setDraftFilters]=useState<OrderFilters>(initialUrlState.filters);
  const [committedFilters,setCommittedFilters]=useState<OrderFilters>(initialUrlState.filters);
  const [showAdvancedFilters,setShowAdvancedFilters]=useState(Object.entries(initialUrlState.filters).some(([key,value])=>key!=="search"&&value));
  const [isComposing, setIsComposing] = useState(false);
  const [loadState,setLoadState]=useState<"loading"|"ready"|"error"|"forbidden">("loading");
  const [loadError,setLoadError]=useState("");
  const [exportError,setExportError]=useState("");
  const [exporting,setExporting]=useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [page,setPage]=useState(initialUrlState.page);
  const [pageSize,setPageSize]=useState<PageSize>(initialUrlState.pageSize);
  const [totalCount,setTotalCount]=useState(0);
  const snapshotRef=useRef(initialUrlState.snapshot);
  const searchRef = useRef<HTMLInputElement>(null);
  const commitFilters=useCallback((value:OrderFilters,historyMode:"push"|"replace"="push",updateDraft=true)=>{
    const normalized:OrderFilters={
      search:value.search.trim(),month:value.month.trim(),status:value.status.trim(),salesperson:value.salesperson.trim(),
      department:value.department.trim(),group:value.group.trim(),region:value.region.trim(),customerUnit:value.customerUnit.trim(),
    };
    snapshotRef.current=null;writeOrderUrlState(normalized,1,pageSize,historyMode,null);
    if(updateDraft)setDraftFilters(normalized);
    setPage(1);
    setCommittedFilters(normalized);
  },[pageSize]);
  useEffect(()=>{
    const restore=()=>{const restored=readOrderUrlState();snapshotRef.current=restored.snapshot;setDraftFilters(restored.filters);setCommittedFilters(restored.filters);setShowAdvancedFilters(Object.entries(restored.filters).some(([key,value])=>key!=="search"&&value));setPage(restored.page);setPageSize(restored.pageSize);setRefreshVersion((value)=>value+1);};
    window.addEventListener("popstate",restore);return()=>window.removeEventListener("popstate",restore);
  },[]);
  useEffect(()=>{
    if(isComposing||draftFilters.search.trim()===committedFilters.search)return;
    const timer=window.setTimeout(()=>commitFilters({...committedFilters,search:draftFilters.search},"replace",false),300);
    return()=>window.clearTimeout(timer);
  },[draftFilters.search,isComposing,committedFilters,commitFilters]);
  const filterRequestKey=JSON.stringify(committedFilters);
  useEffect(() => {
    const controller=new AbortController();setLoadState("loading");setLoadError("");
    const params=new URLSearchParams({page:String(page),pageSize:String(pageSize)});for(const [key,value] of Object.entries(committedFilters))if(value)params.set(key,value);if(snapshotRef.current)params.set("snapshot",snapshotRef.current);
    apiFetch(`/api/performance/orders?${params.toString()}`,{signal:controller.signal}).then(async(response)=>{
      const data=await readResponseJson<{orders?:Order[];page?:number;pageSize?:PageSize;totalCount?:number;snapshot?:string;message?:string}>(response,"订单服务响应无效，请重试");
      if(response.status===403){setOrders([]);setTotalCount(0);setLoadState("forbidden");return;}
      if(!response.ok)throw new Error(data.message??"订单加载失败");
      if(data.snapshot){snapshotRef.current=data.snapshot;writeOrderUrlState(committedFilters,page,pageSize,"replace",data.snapshot);}const total=data.totalCount??0;const lastPage=Math.max(1,Math.ceil(total/pageSize));if(page>lastPage){writeOrderUrlState(committedFilters,lastPage,pageSize,"replace",snapshotRef.current);setPage(lastPage);return;}
      setOrders(data.orders??[]);
      setTotalCount(total);
      setLoadState("ready");
    }).catch((error)=>{if(error instanceof DOMException&&error.name==="AbortError")return;setLoadError(error instanceof Error?error.message:"订单加载失败");setLoadState("error");});
    return()=>controller.abort();
  }, [filterRequestKey,page,pageSize,refreshVersion]);
  const loading=loadState==="loading";
  const hasFilters=Object.values(committedFilters).some(Boolean);
  const activeAdvancedFilterCount=Object.entries(committedFilters).filter(([key,value])=>key!=="search"&&value).length;
  async function refresh() { snapshotRef.current=null;writeOrderUrlState(committedFilters,page,pageSize,"replace",null);setRefreshVersion((value)=>value+1); }
  function changePage(nextPage:number){writeOrderUrlState(committedFilters,nextPage,pageSize,"push",snapshotRef.current);setPage(nextPage);}
  function changePageSize(nextPageSize:PageSize){snapshotRef.current=null;writeOrderUrlState(committedFilters,1,nextPageSize,"push",null);setPageSize(nextPageSize);setPage(1);}
  function clearSearch(){setDraftFilters((current)=>({...current,search:""}));commitFilters({...committedFilters,search:""},"push",false);window.requestAnimationFrame(()=>searchRef.current?.focus());}
  function updateFilter(key:keyof OrderFilters,value:string){setDraftFilters((current)=>({...current,[key]:value}));}
  async function exportOrders(){if(exporting)return;const params=new URLSearchParams();for(const [key,value] of Object.entries(committedFilters))if(value)params.set(key,value);const query=params.toString();setExporting(true);setExportError("");try{await downloadApiFile(`/api/exports/performance.csv${query?`?${query}`:""}`);}catch(failure){setExportError(failure instanceof Error?failure.message:"导出失败，请重试。");}finally{setExporting(false);}}
  const emptyMessage=loadState==="forbidden"?"无可显示订单。":loadState==="error"?"订单加载失败，可重试。":hasFilters?"没有符合当前组合条件的订单。":"暂无订单数据。";
  return <main className="dashboard orders-page" data-onboarding-page="orders"><header data-onboarding="page-header"><div><h1>订单业绩</h1><p>按订单编号维护不可变业绩事件；已入账记录不能覆盖或删除</p></div>{canExport||canEdit ? <div className="header-actions" data-onboarding="page-actions">{canExport?<button className="secondary-action" disabled={exporting} onClick={exportOrders}>{exporting?"正在导出…":"导出当前授权范围匹配订单"}</button>:null}{canEdit?<><button className="secondary-action" onClick={() => setShowImport(true)}><FileUp size={16}/>Excel 导入</button><button className="primary-action" onClick={() => setShowCreate(true)}><Plus size={16}/>录入新订单</button></>:null}</div> : null}</header>
    {exportError?<p className="page-message" role="alert">{exportError}</p>:null}
    {loadState==="error"?<div className="query-feedback"><p className="page-message" role="alert">{loadError}</p><button type="button" onClick={()=>refresh()}>重试查询</button></div>:null}
    {loadState==="forbidden"?<div className="permission-note"><ShieldCheck size={18}/>当前账号没有订单查看权限。</div>:null}
    {!canEdit ? <div className="permission-note"><ShieldCheck size={18}/>当前角色仅可查看。只有销售助理及销售助理组长可以录入或调整业绩。</div> : null}
    <LedgerGovernancePanel user={user} onChanged={refresh}/>
    <section className="orders-card" data-onboarding="primary-content" aria-labelledby="orders-table-title"><div className="orders-toolbar"><div><h2 id="orders-table-title">订单台账</h2><span role="status">{loading?"正在查询…":`本页 ${orders.length} 笔订单`}</span></div><button className="icon-action" onClick={() => refresh()} aria-label="刷新订单"><RefreshCw size={17}/></button></div>
      <form className="order-search" role="search" noValidate onSubmit={(event)=>{event.preventDefault();if(!isComposing)commitFilters({...committedFilters,search:draftFilters.search},"push",false);}}><label htmlFor="order-search-input">定位订单</label><div><Search size={17} aria-hidden="true"/><input ref={searchRef} id="order-search-input" type="search" value={draftFilters.search} maxLength={100} placeholder="订单、客户、单位、业务员或协作人" onChange={(event)=>updateFilter("search",event.target.value)} onCompositionStart={()=>setIsComposing(true)} onCompositionEnd={(event)=>{setIsComposing(false);updateFilter("search",event.currentTarget.value);}}/>{draftFilters.search?<button type="button" onClick={clearSearch} aria-label="清除订单搜索"><X size={16}/></button>:null}</div><button type="submit">搜索</button></form>
      <details className="order-filter-disclosure" data-onboarding="filters" open={showAdvancedFilters} onToggle={(event)=>setShowAdvancedFilters(event.currentTarget.open)}><summary><SlidersHorizontal size={16}/><span>筛选条件</span>{activeAdvancedFilterCount?<small>已应用 {activeAdvancedFilterCount} 项</small>:<small>按月、状态、组织或区域缩小范围</small>}<ChevronDown size={16}/></summary><form className="order-filters" noValidate onSubmit={(event)=>{event.preventDefault();commitFilters(draftFilters);}}><div className="order-filter-grid">
        <label className="field"><span>订单月份</span><input type="month" value={draftFilters.month} onChange={(event)=>updateFilter("month",event.target.value)}/></label>
        <label className="field"><span>订单状态</span><select value={draftFilters.status} onChange={(event)=>updateFilter("status",event.target.value)}><option value="">全部状态</option><option value="active">正向计入</option><option value="receivable_pending">应收未收</option><option value="paused">已暂停</option><option value="zero">零金额</option><option value="historical_review_required">待历史核对</option><option value="draft">草稿</option></select></label>
        <label className="field"><span>业务员筛选</span><input value={draftFilters.salesperson} maxLength={300} onChange={(event)=>updateFilter("salesperson",event.target.value)}/></label>
        <label className="field"><span>部门筛选</span><input value={draftFilters.department} maxLength={300} onChange={(event)=>updateFilter("department",event.target.value)}/></label>
        <label className="field"><span>小组筛选</span><input value={draftFilters.group} maxLength={300} onChange={(event)=>updateFilter("group",event.target.value)}/></label>
        <label className="field"><span>标准业务区域筛选</span><select value={draftFilters.region} onChange={(event)=>updateFilter("region",event.target.value)}><option value="">全部区域</option>{standardBusinessRegions.map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label>
        <label className="field"><span>客户单位筛选</span><input value={draftFilters.customerUnit} maxLength={300} onChange={(event)=>updateFilter("customerUnit",event.target.value)}/></label>
      </div><div className="order-filter-actions"><button type="button" onClick={()=>commitFilters({...emptyOrderFilters})}>清除筛选</button><button type="submit">应用筛选</button></div></form></details>
      <div className="orders-table-wrap order-ledger-scroll" tabIndex={0} role="region" aria-label="订单台账，可横向滚动"><table className="order-ledger-table" aria-label="订单台账"><colgroup>{Array.from({length:5},(_,index)=><col key={index}/>)}</colgroup><thead><tr><th className="order-key-number" scope="col">订单</th><th scope="col">客户 / 区域</th><th scope="col">负责人</th><th scope="col">金额 / 状态</th><th className="order-key-actions" scope="col">操作</th></tr></thead><tbody>{!loading&&orders.length === 0 ? <tr><td colSpan={5} className="empty-cell">{emptyMessage}</td></tr> : orders.map((order) => <tr key={order.id}><td className="order-key-number" title={order.orderNo}><strong>{order.orderNo}</strong><small>{order.sourceReceivedOn} 收样</small></td><td title={`${order.customerName} · ${order.customerUnit}`}><strong>{order.customerName}</strong><small>{order.customerUnit}</small><small>{order.businessRegionCode?businessRegionName(order.businessRegionCode):order.businessRegionSourceText||<span className="data-pending" title="历史订单尚未完成受控分析维度补齐">待补齐</span>}</small></td><td title={`${order.salespersonName} · ${[order.departmentName,order.groupName].filter(Boolean).join(" / ")}`}><strong>{order.salespersonName}</strong><small>{[order.departmentName,order.groupName].filter(Boolean).join(" / ")||"组织待补齐"}</small></td><td className="order-amount-status"><strong>{formatMoney(order.countedAmount)}</strong><small className={order.lifecycleState==="receivable_pending"?"negative":undefined}>系统 {order.lifecycleState==="receivable_pending"?`应收未收 ${formatMoney(Math.abs(Number(order.currentRevenue)))}`:formatMoney(order.currentRevenue)}</small><Status state={order.lifecycleState}/></td><td className="order-key-actions"><button className="table-action" onClick={() => setSelected(order)}>查看 / 调整</button></td></tr>)}</tbody></table></div>
      <Pagination label="订单" page={page} pageSize={pageSize} totalItems={totalCount} disabled={loadState!=="ready"} onPageChange={changePage} onPageSizeChange={changePageSize}/>
    </section>
    {showCreate ? <CreateOrder onClose={() => setShowCreate(false)} onSaved={async () => { setShowCreate(false); await refresh(); }} /> : null}
    {showImport ? <ExcelImportDialog user={user} onClose={() => setShowImport(false)} onImported={async () => { setShowImport(false); await refresh(); }} /> : null}
    {selected ? <AdjustOrder order={selected} canEdit={canEdit} onClose={() => setSelected(null)} onSaved={async () => { setSelected(null); await refresh(); }} /> : null}
  </main>;
}

type ImportConfig = { id:string; name:string; version:number; status:"draft"|"approved"|"retired"; sheetName:string; fixedEventType:"initial"|"legacy_adjustment"|null };
type ImportIssue = { rowNumber:number; code:string; severity:"blocking"|"warning"|"info"; message:string };
type ImportReconciliationSummary = { rows:number; orders:number; events:number; totalAmount:number; monthly:Array<{month:string;events:number;totalAmount:number}> };
type BackfillAmount = { events:number; totalAmount:number };
type ImportReport = { batchId:string; status:"blocked"|"preflight_ready"; sourceSha256:string; issues:ImportIssue[]; summary:{rows:number;orders?:number;events?:number;readyMapped?:number;pending?:number;alreadyMapped?:number;totalAmount:number;blocking:number;warnings?:number}; reconciliation:{actual?:ImportReconciliationSummary;expected?:ImportReconciliationSummary|null;source?:BackfillAmount;readyMapped?:BackfillAmount;pending?:BackfillAmount;alreadyMapped?:BackfillAmount;blocked?:BackfillAmount;matched:boolean|null}; mappings?:Array<{rowNumber:number;eventId:string;sourceKey:string;status:"ready"|"already_mapped";businessRegionCode:string;businessRegionSourceText:string;customerUnit:string}> };

function fileAsBase64(file:File):Promise<string>{return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(new Error("文件读取失败，请重新选择。"));reader.onload=()=>{const result=String(reader.result??"");const comma=result.indexOf(",");if(comma<0){reject(new Error("文件内容无效。"));return;}resolve(result.slice(comma+1));};reader.readAsDataURL(file);});}

function ExcelImportDialog({user,onClose,onImported}:{user:User;onClose:()=>void;onImported:()=>Promise<void>}){
  const[configs,setConfigs]=useState<ImportConfig[]>([]);const[configId,setConfigId]=useState("");const[file,setFile]=useState<File|null>(null);const[report,setReport]=useState<ImportReport|null>(null);const[mode,setMode]=useState<"ledger"|"dimension_backfill">("ledger");const[confirmedWarnings,setConfirmedWarnings]=useState<Set<string>>(new Set());const[error,setError]=useState("");const[loading,setLoading]=useState(true);const[busy,setBusy]=useState(false);const isLeader=user.roles.includes("sales_assistant_leader");
  useEffect(()=>{const controller=new AbortController();apiFetch("/api/imports/configs",{signal:controller.signal}).then(async(response)=>{const data=await response.json() as {configs?:ImportConfig[];message?:string};if(!response.ok)throw new Error(data.message??"导入配置加载失败");const approved=(data.configs??[]).filter((item)=>item.status==="approved");setConfigs(approved);setConfigId(approved[0]?.id??"");}).catch((failure)=>{if(failure instanceof DOMException&&failure.name==="AbortError")return;setError(failure instanceof Error?failure.message:"导入配置加载失败");}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();},[]);
  const availableConfigs=mode==="dimension_backfill"?configs.filter((item)=>item.fixedEventType==="legacy_adjustment"):configs;
  function changeMode(next:"ledger"|"dimension_backfill"){setMode(next);setReport(null);setConfirmedWarnings(new Set());setError("");const candidates=next==="dimension_backfill"?configs.filter((item)=>item.fixedEventType==="legacy_adjustment"):configs;setConfigId(candidates[0]?.id??"");}
  function chooseFile(selected:File|null){setReport(null);setConfirmedWarnings(new Set());setError("");if(!selected){setFile(null);return;}if(!selected.name.toLowerCase().endsWith(".xlsx")){setFile(null);setError("只接受 .xlsx 工作簿。");return;}if(selected.size===0||selected.size>20*1024*1024){setFile(null);setError("文件必须大于 0 且不超过 20 MB。");return;}setFile(selected);}
  async function preflight(event:FormEvent){event.preventDefault();if(busy)return;if(!configId||!file){setError("请选择已批准的导入配置和一个 .xlsx 文件。");return;}setBusy(true);setError("");setReport(null);try{const contentBase64=await fileAsBase64(file);const endpoint=mode==="dimension_backfill"?"/api/imports/dimension-backfills/preflight":"/api/imports/preflight";const response=await apiFetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({configId,fileName:file.name,contentBase64})});const data=await response.json() as ImportReport&{message?:string};if(!response.ok)throw new Error(data.message??"预检失败");setReport(data);}catch(failure){setError(failure instanceof Error?failure.message:"预检失败，请重试。");}finally{setBusy(false);}}
  async function confirm(){if(!report||busy)return;setBusy(true);setError("");try{const endpoint=mode==="dimension_backfill"?`/api/imports/dimension-backfills/${report.batchId}/confirm`:`/api/imports/batches/${report.batchId}/confirm`;const response=await apiFetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:mode==="dimension_backfill"?"{}":JSON.stringify({confirmedWarnings:[...confirmedWarnings]})});const data=await response.json() as {message?:string};if(!response.ok)throw new Error(data.message??(mode==="dimension_backfill"?"确认补齐失败":"确认入账失败"));await onImported();}catch(failure){setError(failure instanceof Error?failure.message:"确认失败，请重试。");}finally{setBusy(false);}}
  const warningKeys=report?.issues.filter((issue)=>issue.severity==="warning").map((issue)=>`${issue.rowNumber}:${issue.code}`)??[];const allWarningsConfirmed=warningKeys.every((key)=>confirmedWarnings.has(key));
  return <Modal title="Excel 批量导入" note="先完整预检，只有销售助理组长可以确认无阻断批次" onClose={onClose} preventClose={busy}><form noValidate className="business-form import-form" onSubmit={preflight}>
    <fieldset className="import-mode"><legend>操作类型</legend><label><input type="radio" name="import-mode" checked={mode==="ledger"} disabled={busy} onChange={()=>changeMode("ledger")}/>业绩入账</label><label><input type="radio" name="import-mode" checked={mode==="dimension_backfill"} disabled={busy} onChange={()=>changeMode("dimension_backfill")}/>历史分析维度补齐</label></fieldset>
    <div className="import-guidance">{mode==="ledger"?<a href="/SampleFlow标准业绩导入模板.xlsx" download>下载标准业绩模板</a>:null}<span>{mode==="dimension_backfill"?"上传原始受控工作簿；只按文件哈希、工作表和行号匹配旧事件，不会修改订单或事件。":"仅接收固定值 .xlsx；公式、宏、外部链接和未知表头会被阻断。"}</span></div>
    <label className="field"><span>已批准导入配置</span><select value={configId} disabled={loading||busy} onChange={(event)=>{setConfigId(event.target.value);setReport(null);}}><option value="">{loading?"正在加载…":"请选择"}</option>{availableConfigs.map((item)=><option key={item.id} value={item.id}>{item.name} · v{item.version}</option>)}</select></label>
    <label className="import-file"><FileUp size={22}/><span>{file?file.name:"选择一个 .xlsx 文件"}</span><small>{file?`${(file.size/1024).toFixed(1)} KB`:"单文件上限 20 MB；不会显示或记录本地路径"}</small><input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} onChange={(event)=>chooseFile(event.currentTarget.files?.[0]??null)}/></label>
    {!loading&&availableConfigs.length===0?<p className="permission-note">{mode==="dimension_backfill"?"暂无已批准的专用历史配置。":"暂无已批准配置。销售助理组长需先创建草稿，并由人事批准业务区域及人员精确映射。"}</p>:null}{error?<p className="form-error" role="alert">{error}</p>:null}
    {report?<section className={`import-report import-${report.status}`} aria-labelledby="import-report-title"><h3 id="import-report-title">{report.status==="blocked"?"预检未通过":"预检通过，等待确认"}</h3><dl><div><dt>来源 SHA-256</dt><dd>{report.sourceSha256}</dd></div>{mode==="dimension_backfill"?<><div><dt>来源行 / 可补齐映射 / 待补齐</dt><dd>{report.summary.rows} / {report.summary.readyMapped} / {report.summary.pending}</dd></div><div><dt>已补齐 / 阻断</dt><dd>{report.summary.alreadyMapped} / {report.summary.blocking}</dd></div></>:<><div><dt>来源行 / 订单 / 待入账事件</dt><dd>{report.summary.rows} / {report.summary.orders} / {report.summary.events}</dd></div><div><dt>阻断 / 警告</dt><dd>{report.summary.blocking} / {report.summary.warnings}</dd></div></>}<div><dt>金额合计</dt><dd>{formatMoney(report.summary.totalAmount)}</dd></div></dl>
      {mode==="dimension_backfill"?<div className="import-reconciliation"><h4>来源对账</h4><p>受控来源 {report.reconciliation.source?.events??0} 笔 / {formatMoney(report.reconciliation.source?.totalAmount??0)}；可补齐映射 {report.reconciliation.readyMapped?.events??0} 笔 / {formatMoney(report.reconciliation.readyMapped?.totalAmount??0)}。</p><p>待补齐 {report.reconciliation.pending?.events??0} 笔 / {formatMoney(report.reconciliation.pending?.totalAmount??0)}；已补齐 {report.reconciliation.alreadyMapped?.events??0} 笔 / {formatMoney(report.reconciliation.alreadyMapped?.totalAmount??0)}；冲突 {report.reconciliation.blocked?.events??0} 笔 / {formatMoney(report.reconciliation.blocked?.totalAmount??0)}。</p><p>{report.reconciliation.matched?"四类数量和金额与受控来源总账对平。":"分类对账失败，批次已阻断。"}</p>{report.mappings?.length?<PaginatedCollection items={report.mappings} label="历史分析维度映射">{(mappings)=><div className="orders-table-wrap" tabIndex={0} role="region" aria-label="历史分析维度映射，可横向滚动"><table><thead><tr><th>来源行</th><th>状态</th><th>标准区域</th><th>区域原文</th><th>客户单位</th></tr></thead><tbody>{mappings.map((mapping)=><tr key={mapping.sourceKey}><td>{mapping.rowNumber}</td><td>{mapping.status==="ready"?"可补齐":"已补齐"}</td><td>{mapping.businessRegionCode}</td><td>{mapping.businessRegionSourceText}</td><td>{mapping.customerUnit}</td></tr>)}</tbody></table></div>}</PaginatedCollection>:null}</div>:<div className="import-reconciliation"><h4>逐月对账</h4><PaginatedCollection items={report.reconciliation.actual?.monthly??[]} label="导入逐月对账">{(months)=><div className="orders-table-wrap" tabIndex={0} role="region" aria-label="导入逐月对账，可横向滚动"><table><thead><tr><th>月份</th><th>实际事件</th><th>实际金额</th><th>预期事件</th><th>预期金额</th></tr></thead><tbody>{months.map((month)=>{const expected=report.reconciliation.expected?.monthly.find((item)=>item.month===month.month);return <tr key={month.month}><td>{month.month}</td><td>{month.events}</td><td>{formatMoney(month.totalAmount)}</td><td>{expected?.events??"—"}</td><td>{expected?formatMoney(expected.totalAmount):"—"}</td></tr>;})}</tbody></table></div>}</PaginatedCollection><p>{report.reconciliation.matched===true?"整体与逐月对账一致。":report.reconciliation.matched===false?"整体或逐月对账不一致，批次已阻断。":"当前配置未设置预期基准，仅展示实际逐月汇总。"}</p></div>}
      {report.issues.length?<PaginatedCollection items={report.issues} label="导入问题">{(issues)=><ul>{issues.map((issue,index)=>{const warningKey=`${issue.rowNumber}:${issue.code}`;const issueLabel=issue.severity==="blocking"?"阻断":issue.severity==="warning"?"警告":"提示";return <li key={`${warningKey}-${index}`}><strong>{issue.rowNumber===0?"批次级":`第 ${issue.rowNumber} 行`} · {issueLabel}</strong><span>{issue.message}</span>{issue.severity==="warning"?<label><input type="checkbox" checked={confirmedWarnings.has(warningKey)} onChange={(event)=>setConfirmedWarnings((current)=>{const next=new Set(current);if(event.target.checked)next.add(warningKey);else next.delete(warningKey);return next;})}/>我已核对并确认此条警告</label>:null}</li>;})}</ul>}</PaginatedCollection>:<p>未发现阻断、警告或提示。</p>}</section>:null}
    <div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button>{!report?<button type="submit" disabled={busy||loading||!file||!configId} aria-busy={busy}>{busy?"正在预检…":"运行只读预检"}</button>:report.status==="preflight_ready"&&isLeader?<button type="button" className="import-confirm" disabled={busy||!allWarningsConfirmed} aria-busy={busy} onClick={confirm}>{busy?"正在确认…":mode==="dimension_backfill"?"确认补齐分析维度":"确认整批入账"}</button>:report.status==="preflight_ready"?<span className="import-handoff">请交由销售助理组长确认</span>:<button type="button" onClick={()=>setReport(null)}>重新选择</button>}</div>
  </form></Modal>;
}

const standardBusinessRegions = [
  ["CN-BJ","北京市"],["CN-TJ","天津市"],["CN-HE","河北省"],["CN-SX","山西省"],["CN-NM","内蒙古自治区"],
  ["CN-LN","辽宁省"],["CN-JL","吉林省"],["CN-HL","黑龙江省"],["CN-SH","上海市"],["CN-JS","江苏省"],
  ["CN-ZJ","浙江省"],["CN-AH","安徽省"],["CN-FJ","福建省"],["CN-JX","江西省"],["CN-SD","山东省"],
  ["CN-HA","河南省"],["CN-HB","湖北省"],["CN-HN","湖南省"],["CN-GD","广东省"],["CN-GX","广西壮族自治区"],
  ["CN-HI","海南省"],["CN-CQ","重庆市"],["CN-SC","四川省"],["CN-GZ","贵州省"],["CN-YN","云南省"],
  ["CN-XZ","西藏自治区"],["CN-SN","陕西省"],["CN-GS","甘肃省"],["CN-QH","青海省"],["CN-NX","宁夏回族自治区"],
  ["CN-XJ","新疆维吾尔自治区"],["CN-TW","台湾省"],
  ["EXT-TRADE","外贸"],
] as const;


const initialOrder = { orderNo: "", customerName: "", customerUnit: "", businessRegionSourceText:"", businessRegionCode: "", salespersonPersonId: "", collaboratorPersonId:"", collaborationRatio:"", serviceType: "", sourceReceivedOn: businessDateToday(), amount: "", reason: "首次录入" };

function previousBusinessMonth():string{const [year,month]=businessDateToday().slice(0,7).split("-").map(Number);return new Date(Date.UTC(year!,month!-2,1)).toISOString().slice(0,7);}

type GovernanceConfirmation=
  |{kind:"close";periodMonth:string;note:string}
  |{kind:"approve-correction"|"revoke-correction";item:AccountingCorrection;note:string}
  |{kind:"approve-review";item:HistoricalReview;note:string};
type GovernancePaging={page:number;pageSize:PageSize;totalCount:number};

function LedgerGovernancePanel({user,onChanged}:{user:User;onChanged:()=>Promise<void>}){
  const isLeader=user.roles.includes("sales_assistant_leader");
  const isHr=user.roles.includes("hr");
  const[periods,setPeriods]=useState<AccountingPeriod[]>([]);
  const[corrections,setCorrections]=useState<AccountingCorrection[]>([]);
  const[reviews,setReviews]=useState<HistoricalReview[]>([]);
  const[periodPaging,setPeriodPaging]=useState<GovernancePaging>({page:1,pageSize:10,totalCount:0});
  const[correctionPaging,setCorrectionPaging]=useState<GovernancePaging>({page:1,pageSize:10,totalCount:0});
  const[reviewPaging,setReviewPaging]=useState<GovernancePaging>({page:1,pageSize:10,totalCount:0});
  const[pendingCorrections,setPendingCorrections]=useState(0);
  const[pendingReviews,setPendingReviews]=useState(0);
  const[month,setMonth]=useState(previousBusinessMonth());
  const[periodNote,setPeriodNote]=useState("");
  const[decisionNote,setDecisionNote]=useState("");
  const[message,setMessage]=useState("");
  const[busy,setBusy]=useState(false);
  const busyRef=useRef(false);
  const[correction,setCorrection]=useState({orderId:"",eventType:"revenue_change",occurredOn:`${previousBusinessMonth()}-01`,reason:"",businessRegionCode:"",businessRegionSourceText:"",customerUnit:"",analysisDimensionEvidence:""});
  const[review,setReview]=useState({orderId:"",lifecycleState:"active",currentRevenue:"",conclusion:"",evidence:"",reason:""});
  const[execution,setExecution]=useState<AccountingCorrection|null>(null);
  const[confirmation,setConfirmation]=useState<GovernanceConfirmation|null>(null);
  const[executionAmount,setExecutionAmount]=useState("");
  const[executionReason,setExecutionReason]=useState("");
  const load=useCallback(async()=>{
    if(!isLeader&&!isHr)return;
    const responses=await Promise.all([
      apiFetch(`/api/accounting-periods?page=${periodPaging.page}&pageSize=${periodPaging.pageSize}`),
      apiFetch(`/api/accounting-corrections?page=${correctionPaging.page}&pageSize=${correctionPaging.pageSize}`),
      apiFetch(`/api/historical-order-reviews?page=${reviewPaging.page}&pageSize=${reviewPaging.pageSize}`),
    ]);
    const data=await Promise.all(responses.map((response)=>response.json()));
    const failed=responses.findIndex((response)=>!response.ok);
    if(failed>=0)throw new Error((data[failed] as {message?:string}).message??"账本治理数据加载失败");
    const periodData=data[0] as {periods?:AccountingPeriod[];totalCount?:number};
    const correctionData=data[1] as {corrections?:AccountingCorrection[];totalCount?:number;pendingCount?:number};
    const reviewData=data[2] as {reviews?:HistoricalReview[];totalCount?:number;pendingCount?:number};
    const periodTotal=periodData.totalCount??0;const correctionTotal=correctionData.totalCount??0;const reviewTotal=reviewData.totalCount??0;
    setPeriods(periodData.periods??[]);setCorrections(correctionData.corrections??[]);setReviews(reviewData.reviews??[]);
    setPeriodPaging((current)=>({...current,totalCount:periodTotal,page:Math.min(current.page,Math.max(1,Math.ceil(periodTotal/current.pageSize)))}));
    setCorrectionPaging((current)=>({...current,totalCount:correctionTotal,page:Math.min(current.page,Math.max(1,Math.ceil(correctionTotal/current.pageSize)))}));
    setReviewPaging((current)=>({...current,totalCount:reviewTotal,page:Math.min(current.page,Math.max(1,Math.ceil(reviewTotal/current.pageSize)))}));
    setPendingCorrections(correctionData.pendingCount??0);setPendingReviews(reviewData.pendingCount??0);
  },[correctionPaging.page,correctionPaging.pageSize,isHr,isLeader,periodPaging.page,periodPaging.pageSize,reviewPaging.page,reviewPaging.pageSize]);
  useEffect(()=>{load().catch((error)=>setMessage(error instanceof Error?error.message:"账本治理数据加载失败"));},[load]);
  if(!isLeader&&!isHr)return null;
  async function post(url:string,payload:unknown){
    if(busyRef.current)return false;
    busyRef.current=true;
    setBusy(true);setMessage("");
    try{const response=await apiFetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});const data=await response.json() as {message?:string};if(!response.ok)throw new Error(data.message??"操作失败");await load();await onChanged();setMessage("操作已记录并刷新。");return true;}
    catch(error){setMessage(error instanceof Error?error.message:"操作失败");return false;}
    finally{busyRef.current=false;setBusy(false);}
  }
  async function submitCorrection(event:FormEvent<HTMLFormElement>){event.preventDefault();if(!correction.orderId||!event.currentTarget.reportValidity())return;const ok=await post("/api/accounting-corrections",{periodMonth:month,orderId:correction.orderId,eventType:correction.eventType,occurredOn:correction.occurredOn,reason:correction.reason,businessRegionCode:correction.businessRegionCode,businessRegionSourceText:correction.businessRegionSourceText,customerUnit:correction.customerUnit,analysisDimensionEvidence:correction.analysisDimensionEvidence});if(ok)setCorrection((current)=>({...current,reason:"",analysisDimensionEvidence:""}));}
  async function submitReview(event:FormEvent){event.preventDefault();if(!review.orderId)return;const ok=await post("/api/historical-order-reviews",{orderId:review.orderId,lifecycleState:review.lifecycleState,currentRevenue:Number(review.currentRevenue),conclusion:review.conclusion,evidence:review.evidence,reason:review.reason});if(ok)setReview((current)=>({...current,currentRevenue:"",conclusion:"",evidence:"",reason:""}));}
  async function executeCorrection(event:FormEvent){event.preventDefault();if(!execution||!executionReason.trim())return;const payload={type:execution.eventType,reason:executionReason,idempotencyKey:crypto.randomUUID(),correctionRequestId:execution.id,...(execution.eventType==="revenue_change"?{newAmount:Number(executionAmount)}:{}),...(execution.eventType==="first_include"?{amount:Number(executionAmount)}:{})};const ok=await post(`/api/performance/orders/${execution.orderId}/events`,payload);if(ok){setExecution(null);setExecutionAmount("");setExecutionReason("");}}
  async function confirmAction(){if(!confirmation)return;const current=confirmation;if(current.kind==="close")await post(`/api/accounting-periods/${current.periodMonth}/close`,{note:current.note});else if(current.kind==="approve-correction")await post(`/api/accounting-corrections/${current.item.id}/approve`,{note:current.note});else if(current.kind==="revoke-correction")await post(`/api/accounting-corrections/${current.item.id}/revoke`,{note:current.note});else await post(`/api/historical-order-reviews/${current.item.id}/approve`,{note:current.note});setConfirmation(null);}
  const confirmationView=confirmation?.kind==="close"?{title:"确认关闭记账期间",subject:confirmation.periodMonth,action:"关闭记账期间",reason:confirmation.note,effect:"期间关闭后，普通补录与调整将被阻断；后续更正只会追加不可变事件。",confirm:"确认关闭",pending:"正在关闭…"}:confirmation?.kind==="approve-correction"?{title:"确认批准更正",subject:confirmation.item.orderNo,action:`批准 ${eventTypeName(confirmation.item.eventType)}`,reason:confirmation.note,effect:"批准后生成 24 小时有效授权，且必须由另一名人员执行。",confirm:"确认批准",pending:"正在批准…"}:confirmation?.kind==="revoke-correction"?{title:"确认撤销更正授权",subject:confirmation.item.orderNo,action:`撤销 ${eventTypeName(confirmation.item.eventType)} 授权`,reason:confirmation.note,effect:"授权将立即失效；已撤销的授权不能再执行。",confirm:"确认撤销",pending:"正在撤销…"}:confirmation?.kind==="approve-review"?{title:"确认批准历史核对",subject:confirmation.item.orderNo,action:`解析为 ${confirmation.item.lifecycleState}`,reason:confirmation.note,effect:"批准后将追加不可变历史核对事件，并更新订单当前投影。",confirm:"确认批准并解析",pending:"正在批准…"}:null;
  return <details className="governance-card governance-workspace" data-onboarding="role-workspace"><summary className="governance-workspace-summary"><span><strong id="ledger-governance-title" role="heading" aria-level={2}>记账治理工作台</strong><small>期间核对、更正申请与历史核对按需展开，职责分离和审计规则不变</small></span><span className="governance-workspace-metrics"><small>{periodPaging.totalCount} 条期间记录</small><small>{pendingCorrections} 项更正待处理</small><small>{pendingReviews} 项核对待处理</small></span><ChevronDown size={18}/></summary><div className="governance-workspace-body" aria-labelledby="ledger-governance-title"><div className="governance-workspace-toolbar"><span>选择一项任务开始处理</span><button className="icon-action" onClick={()=>load().catch((error)=>setMessage(error instanceof Error?error.message:"刷新失败"))} aria-label="刷新记账治理"><RefreshCw size={17}/></button></div>
    {message?<p className="page-message" role="status">{message}</p>:null}

    <div className="governance-grid"><details className="governance-task"><summary><span><strong>{isLeader&&isHr?"期间核对与关账":isHr?"人事关账":"组长核对确认"}</strong><small>按月完成核对确认或关账</small></span><ChevronDown size={17}/></summary><form className="governance-action-form" noValidate onSubmit={(event)=>event.preventDefault()}><label className="field"><span>记账月份</span><input type="month" value={month} onChange={(event)=>{setMonth(event.target.value);setCorrection((current)=>({...current,occurredOn:`${event.target.value}-01`}));}}/></label><Field label={isLeader&&isHr?"核对或关账说明":isHr?"关账说明":"核对说明"} value={periodNote} onChange={setPeriodNote}/>{isLeader?<button type="button" disabled={busy||!periodNote.trim()} aria-busy={busy} onClick={()=>post(`/api/accounting-periods/${month}/confirm-close`,{note:periodNote})}>提交核对确认</button>:null}{isHr?<button type="button" disabled={busy||!periodNote.trim()} aria-busy={busy} onClick={()=>setConfirmation({kind:"close",periodMonth:month,note:periodNote})}>关闭记账期间</button>:null}</form></details>
      {isLeader?<details className="governance-task"><summary><span><strong>申请关闭月更正</strong><small>提交受控更正并等待独立审批</small></span><ChevronDown size={17}/></summary><form className="governance-action-form" noValidate onSubmit={submitCorrection}><label className="field"><span>更正月份</span><input type="month" value={month} onChange={(event)=>{setMonth(event.target.value);setCorrection((current)=>({...current,occurredOn:`${event.target.value}-01`}));}}/></label><OrderLookup id="correction-order" value={correction.orderId} onChange={(orderId)=>setCorrection((current)=>({...current,orderId}))}/><label className="field"><span>更正类型</span><select value={correction.eventType} onChange={(event)=>setCorrection((current)=>({...current,eventType:event.target.value}))}><option value="revenue_change">营业额修改</option><option value="pause">整单暂停</option><option value="restart">订单重启</option><option value="first_include">首次计入</option></select></label><Field label="原业务日期" type="date" value={correction.occurredOn} onChange={(occurredOn)=>setCorrection((current)=>({...current,occurredOn}))}/><label className="field"><span>发生时标准业务区域</span><select required value={correction.businessRegionCode} onChange={(event)=>setCorrection((current)=>({...current,businessRegionCode:event.target.value}))}><option value="">请选择</option>{standardBusinessRegions.map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label><Field label="发生时来源区域原文" value={correction.businessRegionSourceText} onChange={(businessRegionSourceText)=>setCorrection((current)=>({...current,businessRegionSourceText}))}/><Field label="发生时客户单位" value={correction.customerUnit} onChange={(customerUnit)=>setCorrection((current)=>({...current,customerUnit}))}/><Field label="分析维度证据" value={correction.analysisDimensionEvidence} onChange={(analysisDimensionEvidence)=>setCorrection((current)=>({...current,analysisDimensionEvidence}))}/><Field label="申请原因" value={correction.reason} onChange={(reason)=>setCorrection((current)=>({...current,reason}))}/><button type="submit" disabled={busy||!correction.orderId} aria-busy={busy}>提交更正申请</button></form></details>:null}
      {isLeader?<details className="governance-task"><summary><span><strong>提交历史订单核对</strong><small>补录结论与证据后提交人事审批</small></span><ChevronDown size={17}/></summary><form className="governance-action-form" onSubmit={submitReview}><OrderLookup id="review-order" value={review.orderId} requiredLifecycle="historical_review_required" onChange={(orderId)=>setReview((current)=>({...current,orderId}))}/><label className="field"><span>核对后状态</span><select value={review.lifecycleState} onChange={(event)=>setReview((current)=>({...current,lifecycleState:event.target.value}))}><option value="active">正向计入</option><option value="receivable_pending">应收未收</option><option value="paused">已暂停</option><option value="zero">零金额</option></select></label><Field label="核对后当前营业额" type="number" min={review.lifecycleState==="receivable_pending"?"-99999999999.99":review.lifecycleState==="zero"?"0":"0.01"} max={review.lifecycleState==="receivable_pending"?"-0.01":review.lifecycleState==="zero"?"0":"99999999999.99"} value={review.currentRevenue} onChange={(currentRevenue)=>setReview((current)=>({...current,currentRevenue}))}/><Field label="核对结论" value={review.conclusion} onChange={(conclusion)=>setReview((current)=>({...current,conclusion}))}/><Field label="核对依据" value={review.evidence} onChange={(evidence)=>setReview((current)=>({...current,evidence}))}/><Field label="核对原因" value={review.reason} onChange={(reason)=>setReview((current)=>({...current,reason}))}/><button type="submit" disabled={busy||!review.orderId} aria-busy={busy}>提交人事审批</button></form></details>:null}</div>
    {isHr?<label className="field governance-decision"><span>审批意见</span><input value={decisionNote} onChange={(event)=>setDecisionNote(event.target.value)} placeholder="批准、驳回或撤销前填写"/></label>:null}
    <div className="governance-lists"><div><h3>记账期间</h3>{periods.length?<ul>{periods.map((period)=><li key={period.periodMonth}><strong>{period.periodMonth.slice(0,7)}</strong><span>{period.status==="closed"?`已关闭 · 版本 ${period.version}`:"开放"}{period.needsReclose?" · 待重新关账":""}</span></li>)}</ul>:<p>尚无期间治理记录。</p>}<Pagination label="记账期间" page={periodPaging.page} pageSize={periodPaging.pageSize} totalItems={periodPaging.totalCount} disabled={busy} onPageChange={(page)=>setPeriodPaging((current)=>({...current,page}))} onPageSizeChange={(pageSize)=>setPeriodPaging((current)=>({page:1,pageSize,totalCount:current.totalCount}))}/></div><div><h3>更正申请</h3>{corrections.length?<ul>{corrections.map((item)=><li key={item.id}><strong>{item.orderNo} · {eventTypeName(item.eventType)}</strong><span>{item.periodMonth.slice(0,7)} · {item.status} · 申请人 {item.requestedBy}</span><span>{item.businessRegionCode?`${businessRegionName(item.businessRegionCode)}（${item.businessRegionCode}） · ${item.businessRegionSourceText} · ${item.customerUnit} · 证据：${item.analysisDimensionEvidence}`:"缺少发生时分析维度证据，需重新提交"}</span><div className="row-actions">{isHr&&item.status==="pending"?<><button type="button" disabled={busy||!decisionNote.trim()} aria-busy={busy} onClick={()=>setConfirmation({kind:"approve-correction",item,note:decisionNote})}>批准</button><button type="button" disabled={busy||!decisionNote.trim()} aria-busy={busy} onClick={()=>post(`/api/accounting-corrections/${item.id}/reject`,{note:decisionNote})}>驳回</button></>:null}{isHr&&item.status==="approved"?<button type="button" disabled={busy||!decisionNote.trim()} aria-busy={busy} onClick={()=>setConfirmation({kind:"revoke-correction",item,note:decisionNote})}>撤销</button>:null}{isLeader&&item.status==="approved"?<button type="button" disabled={busy} aria-busy={busy} onClick={()=>setExecution(item)}>执行更正</button>:null}</div></li>)}</ul>:<p>暂无更正申请。</p>}<Pagination label="更正申请" page={correctionPaging.page} pageSize={correctionPaging.pageSize} totalItems={correctionPaging.totalCount} disabled={busy} onPageChange={(page)=>setCorrectionPaging((current)=>({...current,page}))} onPageSizeChange={(pageSize)=>setCorrectionPaging((current)=>({page:1,pageSize,totalCount:current.totalCount}))}/></div><div><h3>历史核对</h3>{reviews.length?<ul>{reviews.map((item)=><li key={item.id}><strong>{item.orderNo} · {item.conclusion}</strong><span>{item.status} · 核对人 {item.requestedBy} · 依据 {item.evidence}</span>{isHr&&item.status==="pending"?<div className="row-actions"><button type="button" disabled={busy||!decisionNote.trim()} aria-busy={busy} onClick={()=>setConfirmation({kind:"approve-review",item,note:decisionNote})}>批准并解析</button><button type="button" disabled={busy||!decisionNote.trim()} aria-busy={busy} onClick={()=>post(`/api/historical-order-reviews/${item.id}/reject`,{note:decisionNote})}>驳回</button></div>:null}</li>)}</ul>:<p>暂无历史核对记录。</p>}<Pagination label="历史核对" page={reviewPaging.page} pageSize={reviewPaging.pageSize} totalItems={reviewPaging.totalCount} disabled={busy} onPageChange={(page)=>setReviewPaging((current)=>({...current,page}))} onPageSizeChange={(pageSize)=>setReviewPaging((current)=>({page:1,pageSize,totalCount:current.totalCount}))}/></div></div>
      {execution?<Modal title={`执行更正 · ${execution.orderNo}`} note={`获批范围：${execution.periodMonth.slice(0,7)} / ${eventTypeName(execution.eventType)}；确认后将追加不可变更正事件，并使该期间进入待重新关账。`} onClose={()=>setExecution(null)} preventClose={busy}><form className="business-form" onSubmit={executeCorrection}>{["revenue_change","first_include"].includes(execution.eventType)?<Field label={execution.eventType==="revenue_change"?"调整后营业额":"首次计入金额"} type="number" min={execution.eventType==="first_include"?"0.01":"-99999999999.99"} value={executionAmount} onChange={setExecutionAmount}/>:null}<Field label="执行原因" value={executionReason} onChange={setExecutionReason}/><div className="modal-actions"><button type="button" onClick={()=>setExecution(null)} disabled={busy}>取消</button><button type="submit" disabled={busy||!executionReason.trim()} aria-busy={busy}>{busy?"正在执行…":"确认追加更正事件"}</button></div></form></Modal>:null}
    {confirmation&&confirmationView?<Modal title={confirmationView.title} note="请核对对象、动作、原因与不可变结果" onClose={()=>setConfirmation(null)} preventClose={busy}><div className="governance-confirmation"><dl><div><dt>对象</dt><dd>{confirmationView.subject}</dd></div><div><dt>动作</dt><dd>{confirmationView.action}</dd></div><div><dt>原因</dt><dd>{confirmationView.reason}</dd></div><div><dt>结果</dt><dd>{confirmationView.effect}</dd></div></dl><div className="modal-actions"><button type="button" onClick={()=>setConfirmation(null)} disabled={busy}>取消</button><button type="button" className="import-confirm" disabled={busy} aria-busy={busy} onClick={confirmAction}>{busy?confirmationView.pending:confirmationView.confirm}</button></div></div></Modal>:null}
  </div></details>;
}

function OrderLookup({id,value,onChange,requiredLifecycle}:{id:string;value:string;onChange:(value:string)=>void;requiredLifecycle?:OrderLifecycle}){
  const[query,setQuery]=useState("");const[selected,setSelected]=useState<Order|null>(null);const[state,setState]=useState<"idle"|"loading"|"error"|"empty"|"wrong-state"|"selected">("idle");const[error,setError]=useState("");
  function change(next:string){setQuery(next);setSelected(null);setState("idle");setError("");if(value)onChange("");}
  async function lookup(){if(state==="loading")return;const orderNo=query.trim();if(!orderNo){setError("请输入精确订单编号。");setState("error");return;}setState("loading");setError("");try{const response=await apiFetch(`/api/performance/orders?orderNo=${encodeURIComponent(orderNo)}`);const data=await readResponseJson<{orders?:Order[];message?:string}>(response,"订单查询响应无效，请重试。");if(response.status===403){setState("empty");return;}if(!response.ok)throw new Error(data.message??"订单查询失败");const order=data.orders?.[0];if(!order){setState("empty");return;}if(requiredLifecycle&&order.lifecycleState!==requiredLifecycle){setState("wrong-state");return;}setSelected(order);onChange(order.id);setState("selected");}catch(failure){setError(failure instanceof Error?failure.message:"订单查询失败");setState("error");}}
  const messageId=`${id}-result`;
  return <div className="order-lookup field"><label htmlFor={id}><span>精确订单编号</span></label><div className="order-lookup-controls"><input id={id} value={query} maxLength={100} disabled={state==="loading"} aria-describedby={state!=="idle"?messageId:undefined} onChange={(event)=>change(event.target.value)} placeholder="输入完整订单编号"/><button type="button" disabled={state==="loading"} aria-busy={state==="loading"} onClick={lookup}>{state==="loading"?"正在查询…":state==="error"?"重试查询":"查询订单"}</button></div>{state==="error"?<p id={messageId} className="form-error" role="alert">{error}</p>:state==="empty"?<p id={messageId} className="form-note" role="status">未找到可访问的精确订单。</p>:state==="wrong-state"?<p id={messageId} className="form-note" role="status">该订单当前不处于待历史核对状态。</p>:state==="selected"&&selected?<p id={messageId} className="form-note" role="status">已选择 {selected.orderNo} · {selected.customerName}</p>:state==="loading"?<p id={messageId} className="form-note" role="status">正在查询精确订单…</p>:null}</div>;
}

function CreateOrder({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState(initialOrder);
  const [people, setPeople] = useState<Array<{ id:string; displayName:string; departmentName:string; groupName:string }>>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const dirty=JSON.stringify(form)!==JSON.stringify(initialOrder);const requestClose=()=>{if(confirmDiscard(dirty))onClose();};
  useEffect(() => { const controller=new AbortController();apiFetch(`/api/performance/people?occurredOn=${encodeURIComponent(form.sourceReceivedOn)}`,{signal:controller.signal}).then(async (response) => {
    const data = await response.json() as { people?:Array<{ id:string; displayName:string; departmentName:string; groupName:string }>; message?:string };
    if (!response.ok) throw new Error(data.message ?? "业务员列表加载失败");
    setPeople(data.people ?? []);
  }).catch((reason) => {if(!(reason instanceof DOMException&&reason.name==="AbortError"))setError(reason instanceof Error ? reason.message : "业务员列表加载失败");});return()=>controller.abort(); }, [form.sourceReceivedOn]);
  function set(name: keyof typeof form, value: string) { setForm((current) => ({ ...current, [name]: value })); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (saving) return; setSaving(true); setError("");
    try {
      const collaboration=form.collaboratorPersonId?{collaboratorPersonId:form.collaboratorPersonId,collaborationRatio:Number(form.collaborationRatio)}:{};
      const {collaboratorPersonId:_collaboratorPersonId,collaborationRatio:_collaborationRatio,...order}=form;
      const response = await apiFetch("/api/performance/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...order,...collaboration, amount: Number(form.amount) }) });
      const data = await readResponseJson<{ message?: string }>(response,"订单入账响应无效，请重试。");
      if (!response.ok) throw new Error(data.message ?? "订单入账失败");
      await onSaved();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "订单入账失败"); }
    finally { setSaving(false); }
  }
  const salesperson=people.find((person)=>person.id===form.salespersonPersonId);
  const collaborator=people.find((person)=>person.id===form.collaboratorPersonId);
  return <Modal title="录入订单业绩" note="字段与标准 Sheet3 模板一致；组织归属按日期自动核验" onClose={requestClose} preventClose={saving}><form className="business-form" onSubmit={submit}>
    <p className="form-note">收样月份：{Number(form.sourceReceivedOn.slice(5,7))}月。系统营业额为负数时按“应收未收”入账，不作为退款。</p>
    <div className="form-grid">
      <Field label="订单编号（来源于轻流系统）" value={form.orderNo} onChange={(value)=>set("orderNo",value)}/>
      <Field label="日期" value={form.sourceReceivedOn} type="date" onChange={(value)=>set("sourceReceivedOn",value)}/>
      <Field label="客户姓名" value={form.customerName} onChange={(value)=>set("customerName",value)}/>
      <Field label="客户单位" value={form.customerUnit} onChange={(value)=>set("customerUnit",value)}/>
      <label className="field"><span>省份</span><select aria-label="省份" required value={form.businessRegionCode} onChange={(event)=>{const code=event.target.value;setForm((current)=>({...current,businessRegionCode:code,businessRegionSourceText:standardBusinessRegions.find(([value])=>value===code)?.[1]??""}));}}><option value="">请选择</option>{standardBusinessRegions.map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label>
      <label className="field"><span>业务员</span><select aria-label="业务员" required value={form.salespersonPersonId} onChange={(event)=>set("salespersonPersonId",event.target.value)}><option value="">请选择</option>{people.map((person)=><option key={person.id} value={person.id}>{person.displayName}</option>)}</select>{salesperson?<small>{salesperson.departmentName} / {salesperson.groupName}</small>:null}</label>
      <Field label="服务类型" required={false} value={form.serviceType} onChange={(value)=>set("serviceType",value)}/>
      <Field label="系统营业额" value={form.amount} type="number" min="-99999999999.99" onChange={(value)=>set("amount",value)}/>
      <Field label="备注" required={false} value={form.reason} onChange={(value)=>set("reason",value)}/>
      <label className="field"><span>协作人（可选）</span><select aria-label="协作人（可选）" value={form.collaboratorPersonId} onChange={(event)=>setForm((current)=>({...current,collaboratorPersonId:event.target.value,collaborationRatio:event.target.value?current.collaborationRatio:""}))}><option value="">无协作人</option>{people.filter((person)=>person.id!==form.salespersonPersonId).map((person)=><option key={person.id} value={person.id}>{person.displayName}</option>)}</select>{collaborator?<small>{collaborator.departmentName} / {collaborator.groupName}</small>:null}</label>
      {form.collaboratorPersonId?<label className="field"><span>协作比例</span><input required type="number" min="0.000001" max="0.999999" step="0.000001" value={form.collaborationRatio} onChange={(event)=>set("collaborationRatio",event.target.value)} placeholder="例如 0.2"/><small>填写 0.2 表示协作人分得 20%</small></label>:null}
    </div>
    {error?<p className="form-error" role="alert">{error}</p>:null}<div className="modal-actions"><button type="button" onClick={requestClose} disabled={saving}>取消</button><button type="submit" disabled={saving} aria-busy={saving}>{saving?"正在入账…":"确认入账"}</button></div>
  </form></Modal>;
}

function AdjustOrder({ order, canEdit, onClose, onSaved }: { order: Order; canEdit: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [events,setEvents]=useState<PerformanceEvent[]>([]);
  const [allowed,setAllowed]=useState<string[]>([]);
  const [lifecycle,setLifecycle]=useState<OrderLifecycle>(order.lifecycleState);
  const [loading,setLoading]=useState(true);
  const [type, setType] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving,setSaving]=useState(false);
  const idempotencyKey=useRef(crypto.randomUUID());
  useEffect(()=>{
    const controller=new AbortController();
    apiFetch(`/api/performance/orders/${order.id}/events`,{signal:controller.signal}).then(async(response)=>{
      const data=await response.json() as {events?:PerformanceEvent[];lifecycleState?:OrderLifecycle;allowedActions?:string[];message?:string};
      if(!response.ok)throw new Error(data.message??"事件链加载失败");
      const nextAllowed=data.allowedActions??[];setEvents(data.events??[]);setLifecycle(data.lifecycleState??order.lifecycleState);setAllowed(nextAllowed);setType((current)=>nextAllowed.includes(current)?current:(nextAllowed[0]??""));
    }).catch((failure)=>{if(failure instanceof DOMException&&failure.name==="AbortError")return;setError(failure instanceof Error?failure.message:"事件链加载失败");}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[order.id,order.lifecycleState]);
  async function submit(event: FormEvent) {
    event.preventDefault();if(saving)return;setSaving(true);setError("");
    const payload = { type, reason, idempotencyKey:idempotencyKey.current, ...(type === "revenue_change" ? { newAmount: Number(amount) } : {}), ...(type === "first_include" ? { amount: Number(amount) } : {}) };
    try{
      const response = await apiFetch(`/api/performance/orders/${order.id}/events`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = await readResponseJson<{ message?: string }>(response,"调整入账响应无效，请重试。");
      if (!response.ok) { setError(data.message ?? "调整入账失败"); return; }
      await onSaved();
    }catch{setError("网络异常，结果尚未确认；可安全重试，系统不会重复入账。");}finally{setSaving(false);}
  }
  return <Modal title={order.orderNo} note={`${order.customerName} · 当前营业额 ${formatMoney(order.currentRevenue)} · 计入 ${formatMoney(order.countedAmount)}`} onClose={onClose} preventClose={saving}><section className="order-facts" aria-labelledby="order-facts-title"><div className="event-ledger-heading"><div><h3 id="order-facts-title">订单资料</h3><p>台账次要信息与当前归属</p></div><Status state={lifecycle}/></div><dl><div><dt>客户 / 单位</dt><dd>{order.customerName} / {order.customerUnit}</dd></div><div><dt>收样日期</dt><dd>{order.sourceReceivedOn}</dd></div><div><dt>业务区域</dt><dd>{order.businessRegionCode?`${businessRegionName(order.businessRegionCode)} (${order.businessRegionCode})`:"待补齐"}{order.businessRegionSourceText?` · 来源 ${order.businessRegionSourceText}`:""}</dd></div><div><dt>业务员 / 组织</dt><dd>{order.salespersonName} / {[order.departmentName,order.groupName].filter(Boolean).join(" / ")||"待补齐"}</dd></div><div><dt>负责人快照</dt><dd>组长 {order.leaderName||"—"} / 主管 {order.supervisorName||"—"}</dd></div><div><dt>系统营业额 / 计入业绩</dt><dd>{formatMoney(order.currentRevenue)} / {formatMoney(order.countedAmount)}</dd></div><div><dt>服务类型</dt><dd>{order.serviceType||"—"}</dd></div><div><dt>协作分配</dt><dd>{order.collaboratorName?`${order.collaboratorName} / ${Number(order.collaborationRatio)*100}%`:"—"}</dd></div><div className="order-fact-note"><dt>备注</dt><dd>{order.note||"—"}</dd></div></dl></section><section className="event-ledger" aria-labelledby="event-ledger-title"><div className="event-ledger-heading"><div><h3 id="event-ledger-title">不可变事件链</h3><p>{loading?"正在读取事件…":`${events.length} 条事件 · 按服务端账本序号排列`}</p></div></div>{!loading&&events.length?<PaginatedCollection items={events} label="不可变事件链">{(pageItems)=><ol>{pageItems.map((item)=><li key={item.id}><span className="event-sequence" aria-label={`第 ${item.sequence} 条事件`}>{item.sequence}</span><div className="event-content"><div className="event-summary"><strong>{eventTypeName(item.eventType)}</strong><b className={Number(item.deltaAmount)<0?"negative":""}>{Number(item.deltaAmount)>0?"+":""}{formatMoney(item.deltaAmount)}</b>{item.resultingLifecycleState?<Status state={item.resultingLifecycleState}/>:<span className="legacy-semantic-note">原始状态未推断</span>}</div><dl><div><dt>业务日 / 记账月</dt><dd>{item.occurredOn} / {item.accountingMonth.slice(0,7)}</dd></div><div><dt>操作时间</dt><dd>{formatOperationTime(item.occurredAt)}</dd></div><div><dt>投影结果</dt><dd>营业额 {formatMoney(item.resultingCurrentRevenue)} · 计入 {formatMoney(item.resultingCountedAmount)}</dd></div><div><dt>原因 / 操作者</dt><dd>{item.reason||"—"} / {item.actorName||"历史导入"}</dd></div><div><dt>组织快照</dt><dd>{[item.departmentName,item.groupName].filter(Boolean).join(" / ")||"—"} · 组长 {item.leaderName||"—"} · 主管 {item.supervisorName||"—"}</dd></div>{item.collaboratorName?<div><dt>协作分配</dt><dd>{item.collaboratorName} · {Number(item.collaborationRatio)*100}% · {[item.collaboratorDepartmentName,item.collaboratorGroupName].filter(Boolean).join(" / ")}</dd></div>:null}<div><dt>分析维度快照</dt><dd>{item.businessRegionCode?`${businessRegionName(item.businessRegionCode)} (${item.businessRegionCode}) · 来源 ${item.businessRegionSourceText} · 客户单位 ${item.customerUnit}`:"待补齐（无受控来源证据）"}</dd></div></dl></div></li>)}</ol>}</PaginatedCollection>:!loading&&!error?<p className="event-empty">没有可显示的事件。</p>:null}</section>{error ? <p className="form-error event-error" role="alert">{error}</p> : null}{!loading&&canEdit && allowed.length ? <form className="business-form event-form" onSubmit={submit}><div className="event-options">{allowed.includes("revenue_change") ? <button type="button" className={type==="revenue_change"?"selected":""} aria-pressed={type==="revenue_change"} onClick={() => setType("revenue_change")}><RefreshCw size={17}/>修改营业额</button> : null}{allowed.includes("pause") ? <button type="button" className={type==="pause"?"selected":""} aria-pressed={type==="pause"} onClick={() => setType("pause")}><PauseCircle size={17}/>整单暂停</button> : null}{allowed.includes("restart") ? <button type="button" className={type==="restart"?"selected":""} aria-pressed={type==="restart"} onClick={() => setType("restart")}><PlayCircle size={17}/>订单重启</button> : null}{allowed.includes("first_include") ? <button type="button" className={type==="first_include"?"selected":""} aria-pressed={type==="first_include"} onClick={() => setType("first_include")}><Plus size={17}/>首次计入</button> : null}</div><p className="form-note">操作时间和记账月由服务器确定；调整后营业额允许为负数，表示应收未收。协作比例沿用订单初始值。</p><div className="form-grid">{type === "revenue_change" || type === "first_include" ? <Field label={type === "revenue_change" ? "调整后营业额" : "首次计入金额"} value={amount} type="number" min={type==="first_include"?"0.01":"-99999999999.99"} onChange={setAmount}/> : null}<Field label="原因（必填）" value={reason} onChange={setReason}/></div><div className="modal-actions"><button type="button" onClick={onClose} disabled={saving}>取消</button><button type="submit" disabled={saving} aria-busy={saving}>{saving?"正在追加…":"确认追加事件"}</button></div></form> : !loading?<div className="permission-note">{lifecycle==="historical_review_required"?"该历史订单需要先完成核对与人事批准，当前不能追加事件。":"当前订单状态没有可执行操作，或当前角色仅可查看。"}</div>:null}</Modal>;
}


function businessRegionName(code:string){return standardBusinessRegions.find(([value])=>value===code)?.[1]??code;}
