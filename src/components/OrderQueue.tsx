import { useState } from "react";
import {
  useStore,
  fmtTime,
  fmtDuration,
  inspectionStatus,
  mixHint,
  currentProgress,
} from "../store";
import type { Order } from "../types";

const STATUS_LABEL: Record<Order["status"], string> = {
  scheduled: "已排期",
  filling: "充填中",
  paused: "维护暂停",
  completed: "待签收",
  cancelled: "已取消",
};

const EVENT_LABEL: Record<string, string> = {
  created: "创建",
  rescheduled: "改约",
  started: "开始",
  paused: "暂停",
  resumed: "恢复",
  completed: "完成",
  signed: "签收",
  cancelled: "取消",
};

function OrderCard({ order }: { order: Order }) {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const [signer, setSigner] = useState("");

  const equipment = state.equipment.find((e) => e.id === order.equipmentId);
  const progress = currentProgress(order, state.now);
  const insp = inspectionStatus(order.inspectionExpiry, state.now);
  const mix = mixHint(order.o2, order.he, order.fillMethod);
  const activeMaint = state.maintenance.find(
    (m) => m.id === order.maintenanceId && m.end === null
  );

  return (
    <article className={`order-card order-${order.status}`}>
      <div className="order-head">
        <div>
          <h3>
            {order.code} <small>{order.tankNo}</small>
          </h3>
          <p className="sub">
            {equipment?.name} · {order.volume} · {order.fillMethod}
            {order.fillMethod === "Trimix"
              ? ` O₂${order.o2}% / He${order.he}% / N₂${mix.n2}%`
              : order.fillMethod === "高氧"
              ? ` EAN${order.o2} / N₂${mix.n2}%`
              : ` O₂21% / N₂${mix.n2}%`}
          </p>
        </div>
        <span className={`status-badge ob-${order.status}`}>
          {STATUS_LABEL[order.status]}
        </span>
      </div>

      {insp !== "ok" && (
        <div className={`alert alert-${insp}`}>
          {insp === "expired"
            ? `⛔ 气瓶检验已过期（有效期至 ${fmtTime(order.inspectionExpiry)}），不得充填，须先复检`
            : `⚠️ 检验有效期剩余 ${Math.ceil(
                (order.inspectionExpiry - state.now) / 86_400_000
              )} 天（${fmtTime(order.inspectionExpiry)}）`}
        </div>
      )}
      {mix.warnings.length > 0 && (
        <div className="alert alert-warning">
          {mix.warnings.map((w) => (
            <span key={w}>🧪 {w}</span>
          ))}
        </div>
      )}

      <div className="order-grid">
        <div>
          <span>排班时段</span>
          <b>
            {fmtTime(order.start)} – {fmtTime(order.end)}
          </b>
        </div>
        <div>
          <span>压力</span>
          <b>
            残压 {order.residualPressure} → 目标 {order.targetPressure} bar
          </b>
        </div>
        <div>
          <span>客户 / 电话</span>
          <b>
            {order.contactName} · {order.phone}
          </b>
        </div>
        <div>
          <span>操作员</span>
          <b>{order.operator}</b>
        </div>
      </div>

      {(order.status === "filling" ||
        order.status === "paused" ||
        order.status === "completed") && (
        <div className="progress-row">
          <div className="progress-bar">
            <i style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
          <b>{Math.round(progress * 100)}%</b>
        </div>
      )}

      {order.status === "paused" && (
        <div className="pause-box">
          <div>🔒 维护锁现场保留中</div>
          <p>
            暂停前进度 <b>{Math.round(order.progressBase * 100)}%</b>
            {activeMaint ? ` · 已暂停 ${fmtDuration(state.now - (order.pausedAt ?? state.now))}` : ""}
            {" · "}累计暂停 {fmtDuration(order.totalPauseMs)}
            <br />
            气瓶压力、目标压力、O₂/He 配比与操作员均保持现场状态，维护解锁后按该进度恢复。
          </p>
        </div>
      )}

      {order.status === "filling" && order.totalPauseMs > 0 && (
        <div className="pause-box resumed">
          ↩ 已按暂停前进度 {Math.round(order.progressBase * 100)}% 恢复；累计暂停{" "}
          {fmtDuration(order.totalPauseMs)}
          {order.pauseMinutes > 0 ? `（最近一次 ${order.pauseMinutes} 分钟）` : ""}
          ，完成时间已顺延
        </div>
      )}

      <div className="confirm-line">
        <span>
          改约 {order.rescheduleCount} 次
          {order.rescheduleLocked && (
            <em className="lock-tag">🔒 已达两次 · 沿用首次确认信息</em>
          )}
        </span>
        {order.rescheduleLocked && (
          <span className="confirm-snapshot">
            首次确认（{fmtTime(order.confirmedInfo.frozenAt)}）：
            {order.confirmedInfo.fillMethod}
            {order.confirmedInfo.fillMethod === "Trimix"
              ? ` O₂${order.confirmedInfo.o2}/He${order.confirmedInfo.he}`
              : ` ${order.confirmedInfo.o2}%`}
            {" · "}{order.confirmedInfo.targetPressure}bar · 操作员
            {order.confirmedInfo.operator}
          </span>
        )}
      </div>

      <div className="order-actions">
        {order.status === "scheduled" && (
          <>
            <button
              onClick={() => dispatch({ type: "START_FILL", orderId: order.id })}
              disabled={insp === "expired"}
              title={insp === "expired" ? "检验过期，不能开始充填" : ""}
            >
              开始充填
            </button>
            <button
              onClick={() =>
                dispatch({ type: "MANUAL_RESCHEDULE", orderId: order.id })
              }
            >
              手动改约到最近时段
            </button>
            <button
              className="ghost"
              onClick={() => dispatch({ type: "CANCEL_ORDER", orderId: order.id })}
            >
              取消
            </button>
          </>
        )}
        {order.status === "completed" && !order.signedBy && (
          <div className="sign-row">
            <input
              value={signer}
              onChange={(e) => setSigner(e.target.value)}
              placeholder="签收人姓名（默认客户本人）"
            />
            <button
              className="primary"
              onClick={() =>
                dispatch({ type: "SIGN_ORDER", orderId: order.id, signer })
              }
            >
              客户签收
            </button>
          </div>
        )}
        {order.signedBy && (
          <p className="signed-line">
            ✅ 已由 {order.signedBy} 于 {fmtTime(order.signedAt!)} 签收
          </p>
        )}
        <button className="ghost link" onClick={() => setOpen((v) => !v)}>
          {open ? "收起工单历史" : "查看工单历史"}（{order.events.length}）
        </button>
      </div>

      {open && (
        <ol className="history">
          {[...order.events].reverse().map((ev) => (
            <li key={ev.id} className={`ev ev-${ev.kind}`}>
              <span className="ev-kind">{EVENT_LABEL[ev.kind] ?? ev.kind}</span>
              <time>{fmtTime(ev.t)}</time>
              <p>{ev.message}</p>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "全部" },
  { key: "active", label: "进行中" },
  { key: "scheduled", label: "待充填" },
  { key: "paused", label: "维护暂停" },
  { key: "completed", label: "待签收" },
  { key: "expired", label: "检验过期" },
];

export default function OrderQueue() {
  const { state } = useStore();
  const [filter, setFilter] = useState("all");

  const orders = state.orders.filter((o) => {
    switch (filter) {
      case "active":
        return ["filling", "paused"].includes(o.status);
      case "scheduled":
        return o.status === "scheduled";
      case "paused":
        return o.status === "paused";
      case "completed":
        return o.status === "completed";
      case "expired":
        return o.inspectionExpiry < state.now;
      default:
        return true;
    }
  });

  const rank: Record<Order["status"], number> = {
    paused: 0,
    filling: 1,
    scheduled: 2,
    completed: 3,
    cancelled: 4,
  };
  const sorted = [...orders].sort(
    (a, b) => rank[a.status] - rank[b.status] || a.start - b.start
  );

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>工单队列与历史</p>
          <h2>待充填 / 进行中 / 签收</h2>
        </div>
      </div>
      <div className="chips filter-chips">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={filter === f.key ? "chip-on" : ""}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <div className="order-list">
        {sorted.map((o) => (
          <OrderCard key={o.id} order={o} />
        ))}
        {sorted.length === 0 && <p className="muted">该分类下暂无工单</p>}
      </div>
    </section>
  );
}
