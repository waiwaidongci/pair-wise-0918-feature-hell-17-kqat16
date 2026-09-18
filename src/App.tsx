import { StoreProvider, useStore, fmtTime } from "./store";
import EquipmentBoard from "./components/EquipmentBoard";
import ScheduleBoard from "./components/ScheduleBoard";
import OrderQueue from "./components/OrderQueue";
import NewOrderForm from "./components/NewOrderForm";
import AuditPanel from "./components/AuditPanel";

function Metrics() {
  const { state } = useStore();
  const waiting = state.orders.filter((o) => o.status === "scheduled").length;
  const expired = state.orders.filter(
    (o) =>
      o.inspectionExpiry < state.now &&
      ["scheduled", "filling", "paused"].includes(o.status)
  ).length;
  const active = state.orders.filter((o) => o.status !== "cancelled");
  const avgO2 =
    active.length > 0
      ? Math.round((active.reduce((s, o) => s + o.o2, 0) / active.length) * 10) / 10
      : 0;
  const signed = state.orders.filter((o) => o.signedBy).length;
  const paused = state.orders.filter((o) => o.status === "paused").length;
  const maint = state.maintenance.filter((m) => m.end === null).length;

  const items = [
    { label: "待充填工单", value: waiting },
    { label: "检验过期提醒", value: expired },
    { label: "维护锁 / 暂停", value: `${maint} 台 / ${paused} 单` },
    { label: "平均氧含量", value: `${avgO2}%` },
    { label: "已签收单", value: signed },
  ];

  return (
    <section className="metrics">
      {items.map((m) => (
        <article key={m.label}>
          <small>{m.label}</small>
          <strong>{m.value}</strong>
        </article>
      ))}
    </section>
  );
}

function TimeControls() {
  const { state, dispatch } = useStore();
  const jump = (min: number) =>
    dispatch({ type: "TICK", now: state.now + min * 60_000 });
  return (
    <div className="clock-bar">
      <span className="clock">🕒 演示时钟 {fmtTime(state.now)}</span>
      <button onClick={() => jump(10)}>快进 10 分钟</button>
      <button onClick={() => jump(30)}>快进 30 分钟</button>
      <button onClick={() => jump(60)}>快进 1 小时</button>
      <span className="hint">时钟自动每 15 秒推进 1 分钟，用于观察自动开始、完成与维护流程</span>
    </div>
  );
}

function Workspace() {
  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62010 · 潜水气瓶充填 · 充填台维护锁工作流</p>
        <h1>设备维护锁与自动改约排班</h1>
        <span>
          压缩机 / 充填泵进入维护时：未开始的工单自动改约到同设备最近可用时段且绝不重叠；
          已开始的工单保留现场、记录暂停时长，并在维护结束后按暂停前进度恢复；
          同一客户改约两次后沿用首次确认信息；设备状态、工单历史与刷新后的排班保持一致。
        </span>
        <TimeControls />
      </section>

      <Metrics />
      <EquipmentBoard />
      <ScheduleBoard />

      <section className="workspace workspace-wide">
        <OrderQueue />
        <NewOrderForm />
      </section>

      <AuditPanel />
    </main>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Workspace />
    </StoreProvider>
  );
}
