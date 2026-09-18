import { fmt } from "../domain";
import { advanceClock, resetAll, useStore } from "../store";

function Metrics() {
  const orders = useStore((s) => s.orders);
  const now = useStore((_s, t) => t);
  const waiting = orders.filter((o) => o.status === "confirmed").length;
  const paused = orders.filter((o) => o.status === "paused").length;
  const expiredSoon = orders.filter((o) => {
    const end = new Date(o.tank.inspectionExpiry + "T23:59:59").getTime();
    return end - now < 30 * 24 * 3600 * 1000;
  }).length;
  const active = orders.filter((o) => o.status !== "cancelled" && o.status !== "signed");
  const avgO2 = active.length
    ? Math.round((active.reduce((s, o) => s + o.tank.oxygenPct, 0) / active.length) * 10) / 10
    : 0;
  const signed = orders.filter((o) => o.status === "signed").length;

  const items: [string, string | number, string][] = [
    ["待充填", waiting, "未开始、按排班等待"],
    ["暂停保留", paused, "维护期间现场保留工单"],
    ["检验提醒", expiredSoon, "30 天内到期或已过期"],
    ["平均氧含量", `${avgO2}%`, "在役工单混合气均值"],
    ["签收单", signed, "已完成客户签收"],
  ];

  return (
    <section className="metrics">
      {items.map(([label, val, tip]) => (
        <article key={label} title={tip}>
          <small>{label}</small>
          <strong>{val}</strong>
        </article>
      ))}
    </section>
  );
}

export default function Header() {
  const now = useStore((_s, t) => t);
  const maintCount = useStore((s) =>
    s.equipments.filter((e) => e.maintenance && e.maintenance.actualEnd === null).length,
  );

  return (
    <>
      <section className="hero compact">
        <p>hxyfront-62010 · 潜水气瓶充填记录 · Port 62010</p>
        <h1>充填台 · 设备维护锁</h1>
        <span>
          压缩机 / 充填泵进入维护时，未开始工单自动改约最近可用时段且同设备不重叠；进行中工单保留现场、记录暂停时长，维护结束按暂停前进度恢复。客户改约满两次后沿用首次确认信息。
        </span>
        <div className="clock-bar">
          <div className="clock">
            演示时钟 <b>{fmt(now)}</b>
            {maintCount > 0 && <span className="clock-maint">{maintCount} 台设备维护中</span>}
          </div>
          <div className="clock-actions">
            <button onClick={() => advanceClock(15)}>推进 15 分钟</button>
            <button onClick={() => advanceClock(60)}>推进 60 分钟（模拟超时）</button>
            <button className="ghost" onClick={resetAll}>
              重置演示数据
            </button>
          </div>
        </div>
      </section>
      <Metrics />
    </>
  );
}
