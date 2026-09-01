import { useEffect, useState } from "react";
import { apiFetch, businessDateToday, eventTypeName, formatMoney, readResponseJson } from "../app-api";
import type { AnalysisCustomer, AnalysisCustomersDrilldown, AnalysisEventsDrilldown, AnalysisMonthsDrilldown, AnalysisProvince, PerformanceAnalysis } from "../app-types";
import type { ChinaMap } from "../china-map";
import { Metric, Status } from "../shared-ui";

const chinaMapRegionCodes:Record<string,string>={
  "110000":"CN-BJ","120000":"CN-TJ","130000":"CN-HE","140000":"CN-SX","150000":"CN-NM",
  "210000":"CN-LN","220000":"CN-JL","230000":"CN-HL","310000":"CN-SH","320000":"CN-JS",
  "330000":"CN-ZJ","340000":"CN-AH","350000":"CN-FJ","360000":"CN-JX","370000":"CN-SD",
  "410000":"CN-HA","420000":"CN-HB","430000":"CN-HN","440000":"CN-GD","450000":"CN-GX",
  "460000":"CN-HI","500000":"CN-CQ","510000":"CN-SC","520000":"CN-GZ","530000":"CN-YN",
  "540000":"CN-XZ","610000":"CN-SN","620000":"CN-GS","630000":"CN-QH","640000":"CN-NX",
  "650000":"CN-XJ","710000":"CN-TW","810000":"CN-HK","820000":"CN-MO",
};

export function AnalysisPage(){
  const[month,setMonth]=useState(businessDateToday().slice(0,7));
  const[data,setData]=useState<PerformanceAnalysis|null>(null);
  const[error,setError]=useState("");
  const[revision,setRevision]=useState(0);
  const[selectedProvince,setSelectedProvince]=useState<AnalysisProvince|null>(null);
  useEffect(()=>setSelectedProvince(null),[month]);
  useEffect(()=>{const controller=new AbortController();setData(null);setError("");fetch(`/api/performance/analysis?month=${month}`,{signal:controller.signal}).then(async(response)=>{const result=await readResponseJson<PerformanceAnalysis&{message?:string}>(response,"分析服务响应无效");if(!response.ok)throw new Error(result.message??"分析加载失败");setData(result);}).catch((failure)=>{if(failure instanceof DOMException&&failure.name==="AbortError")return;setError(failure instanceof Error?failure.message:"分析加载失败");});return()=>controller.abort();},[month,revision]);
  return <main className="dashboard analysis-page"><section className="analysis-panel" aria-labelledby="analysis-title"><div className="analysis-header"><div><h1 id="analysis-title">地区与客户单位分析</h1><p>只按事件发生时的不可变分析维度快照汇总，不使用订单当前资料</p></div><label><span>分析月份</span><input type="month" value={month} onChange={(event)=>setMonth(event.target.value)}/></label></div>
    {error?<div className="query-feedback"><p className="page-message" role="alert">{error}</p><button type="button" onClick={()=>setRevision((value)=>value+1)}>重试查询</button></div>:null}
    {!data&&!error?<p className="analysis-loading" role="status">正在读取地区与客户单位分析…</p>:null}
    {data?<><section className="metric-band analysis-metrics"><Metric label="授权范围总账" value={formatMoney(data.ledger.totalAmount)} note={`${data.ledger.eventCount} 条事件`}/><Metric label="已映射" value={formatMoney(data.mapped.totalAmount)} note={`${data.mapped.eventCount} 条可信维度事件`}/><Metric label="待补齐" value={formatMoney(data.pending.totalAmount)} note={`${data.pending.eventCount} 条缺少可信维度事件`} warning/></section><p className={`analysis-reconciliation ${data.reconciled?"":"analysis-reconciliation-error"}`}>{data.reconciled?"已映射金额 + 待补齐金额与授权范围总账完全对平。":"分析维度对账失败，请停止使用当前汇总。"}</p><div className="analysis-map-layout"><ChinaProvinceMap provinces={data.provinces} selectedRegionCode={selectedProvince?.regionCode??null} onSelect={setSelectedProvince}/><article className="analysis-card analysis-province-ranking"><h3>省份汇总</h3><div className="orders-table-wrap"><table aria-label="省份汇总"><thead><tr><th>省份</th><th>事件</th><th>金额</th></tr></thead><tbody>{data.provinces.length?data.provinces.map((item)=><tr key={item.regionCode}><td><button type="button" className="analysis-link" aria-pressed={selectedProvince?.regionCode===item.regionCode} onClick={()=>setSelectedProvince(item)}>{item.regionName}</button></td><td>{item.eventCount}</td><td className={Number(item.totalAmount)<0?"negative":""}>{formatMoney(item.totalAmount)}</td></tr>):<tr><td colSpan={3} className="empty-cell">本月没有已映射省份事件。</td></tr>}</tbody></table></div><div className="analysis-foreign"><div><strong>外贸（EXT-TRADE）</strong><span>独立区域，不进入省份统计</span></div><b className={Number(data.foreignTrade.totalAmount)<0?"negative":""}>{data.foreignTrade.eventCount} 条事件 · {formatMoney(data.foreignTrade.totalAmount)}</b></div></article></div><article className="analysis-card analysis-customer-summary"><h3>客户单位汇总</h3><div className="orders-table-wrap"><table aria-label="客户单位汇总"><thead><tr><th>区域</th><th>客户单位</th><th>事件</th><th>金额</th></tr></thead><tbody>{data.customers.length?data.customers.map((item)=><tr key={`${item.regionCode}:${item.customerUnit}`}><td>{item.regionName}</td><td>{item.customerUnit}</td><td>{item.eventCount}</td><td className={Number(item.totalAmount)<0?"negative":""}>{formatMoney(item.totalAmount)}</td></tr>):<tr><td colSpan={4} className="empty-cell">本月没有已映射客户单位事件。</td></tr>}</tbody></table></div></article>{selectedProvince?<AnalysisDrilldown key={`${month}:${selectedProvince.regionCode}`} province={selectedProvince} month={month}/>:null}</>:null}
  </section></main>;
}

function ChinaProvinceMap({provinces,selectedRegionCode,onSelect}:{provinces:AnalysisProvince[];selectedRegionCode:string|null;onSelect:(province:AnalysisProvince)=>void}){
  const[chinaMap,setChinaMap]=useState<ChinaMap|null>(null);
  const[mapError,setMapError]=useState("");
  useEffect(()=>{const controller=new AbortController();import("../china-map").then(({loadChinaMap})=>loadChinaMap(controller.signal)).then(setChinaMap).catch((failure)=>{if(failure instanceof DOMException&&failure.name==="AbortError")return;setMapError(failure instanceof Error?failure.message:"中国省级地图加载失败");});return()=>controller.abort();},[]);
  const byCode=new Map(provinces.map((province)=>[province.regionCode,province]));
  const finiteTotals=provinces.map((province)=>Math.abs(Number(province.totalAmount))).filter(Number.isFinite);
  const maximum=Math.max(1,...finiteTotals);
  return <article className="analysis-card analysis-map-card"><h3>省份地图</h3><div className="analysis-map-wrap">{chinaMap?<svg className="analysis-map" viewBox={chinaMap.viewBox} role="group" aria-label="中国省份业绩地图">{chinaMap.locations.map((location)=>{
    const regionCode=chinaMapRegionCodes[location.id];
    const province=regionCode?byCode.get(regionCode):undefined;
    if(!province)return <path key={location.id} d={location.path} className="analysis-map-empty" data-region-code={regionCode} aria-hidden="true"/>;
    const selected=selectedRegionCode===province.regionCode;
    const label=`地图选择${province.regionName}，${province.eventCount} 条事件，金额 ${formatMoney(province.totalAmount)}`;
    return <path key={location.id} d={location.path} className={`analysis-map-region${Number(province.totalAmount)<0?" negative":""}${selected?" selected":""}`} style={{fillOpacity:.3+.7*Math.abs(Number(province.totalAmount))/maximum}} data-region-code={regionCode} role="button" tabIndex={0} aria-label={label} aria-pressed={selected} onClick={()=>onSelect(province)} onKeyDown={(event)=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onSelect(province);}}}/>;
  })}</svg>:<p className={mapError?"page-message":"analysis-loading"} role={mapError?"alert":"status"}>{mapError||"正在读取中国省级地图…"}</p>}<p>颜色深浅只表示相对规模；金额以右侧省份汇总为准。</p><p><span>台湾省资料暂缺</span>；香港特别行政区、澳门特别行政区资料暂缺。</p><small>省级轮廓：<a href="https://www.tianditu.gov.cn/">天地图</a>来源；<a href="https://github.com/JayMuShui/chinese-global-compliant-geodata">chinese-global-compliant-geodata 1.0.0</a>（MIT）。</small></div></article>;
}

function AnalysisDrilldown({province,month}:{province:AnalysisProvince;month:string}){
  const[customers,setCustomers]=useState<AnalysisCustomersDrilldown|null>(null);
  const[customersError,setCustomersError]=useState("");
  const[customersRevision,setCustomersRevision]=useState(0);
  const[customerCursor,setCustomerCursor]=useState<string|null>(null);
  const[customersLoadingMore,setCustomersLoadingMore]=useState(false);
  const[selectedCustomer,setSelectedCustomer]=useState<AnalysisCustomer|null>(null);
  const[months,setMonths]=useState<AnalysisMonthsDrilldown|null>(null);
  const[monthsError,setMonthsError]=useState("");
  const[monthsRevision,setMonthsRevision]=useState(0);
  const[selectedMonth,setSelectedMonth]=useState<{month:string;eventCount:number;totalAmount:string}|null>(null);
  const[events,setEvents]=useState<AnalysisEventsDrilldown|null>(null);
  const[eventsError,setEventsError]=useState("");
  const[eventsRevision,setEventsRevision]=useState(0);
  const[eventCursor,setEventCursor]=useState<string|null>(null);
  const[eventsLoadingMore,setEventsLoadingMore]=useState(false);

  useEffect(()=>{
    const append=customerCursor!==null;const controller=new AbortController();if(!append){setCustomers(null);setSelectedCustomer(null);setMonths(null);setSelectedMonth(null);setEvents(null);}else setCustomersLoadingMore(true);setCustomersError("");
    const params=new URLSearchParams({level:"customers",regionCode:province.regionCode,month});if(customerCursor)params.set("cursor",customerCursor);
    apiFetch(`/api/performance/analysis/drilldown?${params}`,{signal:controller.signal}).then(async(response)=>{const result=await readResponseJson<AnalysisCustomersDrilldown&{message?:string}>(response,"省份客户响应无效");if(!response.ok)throw new Error(result.message??"省份客户加载失败");setCustomers((current)=>append&&current?{...result,customers:[...current.customers,...result.customers]}:result);}).catch((failure)=>{if(failure instanceof DOMException&&failure.name==="AbortError")return;setCustomersError(failure instanceof Error?failure.message:"省份客户加载失败");}).finally(()=>{if(!controller.signal.aborted)setCustomersLoadingMore(false);});
    return()=>controller.abort();
  },[province.regionCode,month,customerCursor,customersRevision]);

  useEffect(()=>{
    setMonths(null);setMonthsError("");setSelectedMonth(null);setEvents(null);setEventCursor(null);if(!selectedCustomer)return;
    const controller=new AbortController();const params=new URLSearchParams({level:"months",regionCode:province.regionCode,customerUnit:selectedCustomer.customerUnit,year:month.slice(0,4)});
    apiFetch(`/api/performance/analysis/drilldown?${params}`,{signal:controller.signal}).then(async(response)=>{const result=await readResponseJson<AnalysisMonthsDrilldown&{message?:string}>(response,"客户月份响应无效");if(!response.ok)throw new Error(result.message??"客户月份加载失败");setMonths(result);}).catch((failure)=>{if(failure instanceof DOMException&&failure.name==="AbortError")return;setMonthsError(failure instanceof Error?failure.message:"客户月份加载失败");});
    return()=>controller.abort();
  },[province.regionCode,selectedCustomer,month,monthsRevision]);

  useEffect(()=>{
    const append=eventCursor!==null;if(!append)setEvents(null);setEventsError("");if(!selectedCustomer||!selectedMonth)return;
    const controller=new AbortController();if(append)setEventsLoadingMore(true);const params=new URLSearchParams({level:"events",regionCode:province.regionCode,customerUnit:selectedCustomer.customerUnit,month:selectedMonth.month});if(eventCursor)params.set("cursor",eventCursor);
    apiFetch(`/api/performance/analysis/drilldown?${params}`,{signal:controller.signal}).then(async(response)=>{const result=await readResponseJson<AnalysisEventsDrilldown&{message?:string}>(response,"订单事件响应无效");if(!response.ok)throw new Error(result.message??"订单事件加载失败");setEvents((current)=>{if(!append||!current)return result;const orders=new Map(current.orders.map((order)=>[order.orderId,{...order,events:[...order.events]}]));for(const order of result.orders){const existing=orders.get(order.orderId);if(existing)existing.events.push(...order.events);else orders.set(order.orderId,order);}return{...result,orders:[...orders.values()]};});}).catch((failure)=>{if(failure instanceof DOMException&&failure.name==="AbortError")return;setEventsError(failure instanceof Error?failure.message:"订单事件加载失败");}).finally(()=>{if(!controller.signal.aborted)setEventsLoadingMore(false);});
    return()=>controller.abort();
  },[province.regionCode,selectedCustomer,selectedMonth,eventCursor,eventsRevision]);

  const customerMatched=customers&&formatMoney(customers.totalAmount)===formatMoney(province.totalAmount)&&customers.eventCount===province.eventCount;
  const monthRows=new Map(months?.months.map((item)=>[item.month,item])??[]);
  const filledMonths=Array.from({length:12},(_,index)=>{const value=`${month.slice(0,4)}-${String(index+1).padStart(2,"0")}`;return monthRows.get(value)??{month:value,eventCount:0,totalAmount:"0.00"};});
  const parentMonth=months&&selectedCustomer?monthRows.get(month):null;
  const monthMatched=parentMonth&&selectedCustomer&&formatMoney(parentMonth.totalAmount)===formatMoney(selectedCustomer.totalAmount)&&parentMonth.eventCount===selectedCustomer.eventCount;
  const eventsMatched=events&&selectedMonth&&formatMoney(events.totalAmount)===formatMoney(selectedMonth.totalAmount)&&events.eventCount===selectedMonth.eventCount;
  const allEvents=events?.orders.flatMap((order)=>order.events)??[];
  return <section className="analysis-drilldown" role="region" aria-label="分析穿透"><header><h3>{province.regionName}客户单位</h3><p>{province.eventCount} 条事件 · 省份汇总 <strong>{formatMoney(province.totalAmount)}</strong></p></header>
    {customersError?<div className="query-feedback"><p className="page-message" role="alert">{customersError}</p><button type="button" disabled={customersLoadingMore} onClick={()=>setCustomersRevision((value)=>value+1)}>重试省份客户</button></div>:null}
    {!customers&&!customersError?<p className="analysis-loading" role="status">正在读取{province.regionName}客户单位…</p>:null}
    {customers?<><p className={`analysis-reconciliation ${customerMatched?"":"analysis-reconciliation-error"}`}>{customerMatched?`服务端客户事件数与金额 ${formatMoney(customers.totalAmount)} 均与省份汇总完全对平。`:"客户合计与省份汇总不一致，请停止使用当前穿透结果。"}</p><div className="orders-table-wrap"><table aria-label={`${province.regionName}客户单位`}><thead><tr><th>客户单位</th><th>事件</th><th>金额</th><th>穿透</th></tr></thead><tbody>{customers.customers.length?customers.customers.map((customer)=><tr key={customer.customerUnit}><td>{customer.customerUnit}</td><td>{customer.eventCount}</td><td className={Number(customer.totalAmount)<0?"negative":""}>{formatMoney(customer.totalAmount)}</td><td><button type="button" className="table-action" aria-pressed={selectedCustomer?.customerUnit===customer.customerUnit} aria-label={`查看${customer.customerUnit}月份趋势`} onClick={()=>setSelectedCustomer(customer)}>查看月份</button></td></tr>):<tr><td colSpan={4} className="empty-cell">该省份本月没有客户单位事件。</td></tr>}</tbody></table></div><nav className="table-pagination" aria-label="客户单位分页"><span>已加载 {customers.customers.length} / {customers.customerCount} 个客户单位</span>{customers.nextCursor?<button type="button" disabled={customersLoadingMore} onClick={()=>setCustomerCursor(customers.nextCursor)}>{customersLoadingMore?"正在加载…":"加载更多客户单位"}</button>:null}</nav></>:null}
    {selectedCustomer?<section className="analysis-drilldown-stage"><header><h3>{selectedCustomer.customerUnit}月度趋势</h3><p>{month.slice(0,4)} 年 · 客户年度净额 {months?formatMoney(months.totalAmount):"读取中"}</p></header>{monthsError?<div className="query-feedback"><p className="page-message" role="alert">{monthsError}</p><button type="button" onClick={()=>setMonthsRevision((value)=>value+1)}>重试客户月份</button></div>:null}{!months&&!monthsError?<p className="analysis-loading" role="status">正在读取{selectedCustomer.customerUnit}月度趋势…</p>:null}{months?<><p className={`analysis-reconciliation ${monthMatched?"":"analysis-reconciliation-error"}`}>{monthMatched?`${month.replace("-","年")}月金额与上级客户行完全对平。`:`${month.replace("-","年")}月金额与上级客户行不一致，请停止使用当前穿透结果。`}</p><div className="analysis-months" role="list" aria-label={`${selectedCustomer.customerUnit}${months.year}年月度趋势`}>{filledMonths.map((item)=><div key={item.month} role="listitem"><button type="button" className={selectedMonth?.month===item.month?"selected":""} aria-pressed={selectedMonth?.month===item.month} aria-label={`查看${Number(item.month.slice(0,4))}年${Number(item.month.slice(5))}月订单事件，${item.eventCount} 条事件，金额 ${formatMoney(item.totalAmount)}`} onClick={()=>{setEventCursor(null);setSelectedMonth(item);}}><span>{Number(item.month.slice(5))}月</span><strong className={Number(item.totalAmount)<0?"negative":""}>{formatMoney(item.totalAmount)}</strong><small>{item.eventCount} 条事件</small></button></div>)}</div></>:null}</section>:null}
    {selectedMonth&&selectedCustomer?<section className="analysis-drilldown-stage"><header><h3>{Number(selectedMonth.month.slice(0,4))}年{Number(selectedMonth.month.slice(5))}月订单与事件</h3><p>{selectedCustomer.customerUnit} · 上级月份净额 {formatMoney(selectedMonth.totalAmount)}</p></header>{eventsError?<div className="query-feedback"><p className="page-message" role="alert">{eventsError}</p><button type="button" disabled={eventsLoadingMore} onClick={()=>setEventsRevision((value)=>value+1)}>重试订单事件</button></div>:null}{!events&&!eventsError?<p className="analysis-loading" role="status">正在读取订单与不可变事件…</p>:null}{events?<><p className={`analysis-reconciliation ${eventsMatched?"":"analysis-reconciliation-error"}`}>{eventsMatched?`服务端全部订单事件合计 ${formatMoney(events.totalAmount)} 与上级月份完全对平。`:"订单事件合计与上级月份不一致，请停止使用当前穿透结果。"}</p><p className="analysis-loading">已加载 {allEvents.length} / {events.eventCount} 条事件</p><div className="orders-table-wrap"><table aria-label="订单对账"><thead><tr><th>订单</th><th>客户</th><th>事件</th><th>净额</th></tr></thead><tbody>{events.orders.length?events.orders.map((order)=><tr key={order.orderId}><td>{order.orderNo}</td><td>{order.customerName}</td><td>{order.eventCount}</td><td className={Number(order.totalAmount)<0?"negative":""}>{formatMoney(order.totalAmount)}</td></tr>):<tr><td colSpan={4} className="empty-cell">该月份没有订单事件。</td></tr>}</tbody></table></div>{allEvents.length?<div className="orders-table-wrap"><table aria-label="不可变事件明细"><thead><tr><th>序号</th><th>事件</th><th>金额</th><th>业务日 / 记账月</th><th>发生时分析维度</th><th>责任归属</th><th>状态 / 原因</th></tr></thead><tbody>{allEvents.map((event)=><tr key={event.id}><td>第 {event.sequence} 条</td><td>{eventTypeName(event.eventType)}</td><td className={Number(event.deltaAmount)<0?"negative":""}>{formatMoney(event.deltaAmount)}</td><td>{event.occurredOn} / {event.accountingMonth}</td><td>{province.regionName} / {event.customerUnit}<small className="table-secondary">{event.businessRegionSourceText}</small></td><td>{event.salespersonName}<small className="table-secondary">{[event.departmentName,event.groupName].filter(Boolean).join(" / ")||"—"}</small></td><td>{event.resultingLifecycleState?<Status state={event.resultingLifecycleState}/>:"原始状态未推断"}<small className="table-secondary">{event.reason??"—"}</small></td></tr>)}</tbody></table></div>:null}{events.nextCursor?<nav className="table-pagination" aria-label="事件分页"><button type="button" disabled={eventsLoadingMore} onClick={()=>setEventCursor(events.nextCursor)}>{eventsLoadingMore?"正在加载…":"加载更多事件"}</button></nav>:null}</>:null}</section>:null}
  </section>;
}
