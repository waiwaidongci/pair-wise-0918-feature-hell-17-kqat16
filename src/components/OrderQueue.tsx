import { useMemo, useState } from "react";
import type { Order, OrderStatus } from "../types";
import {
  MIN,
  completeFill,
  confirmCustomer,
  fmt,
  fmtDuration,
  inspectionState,
  isMaintenanceAt,
  logPressure,
  mixHint,
  rescheduleOrder,
  signOrder,
  startFill,
} from "../domain";
import { getNow, getState, setState, useStore } from "../store";

const STATUS_LABEL: Record<OrderStatus, string> = {
  confirmed: "待充填",
  inProgress: "充填中",
  paused: "暂停保留",
  completed: "待签收",
  signed: "已签收",
  cancelled: "已取消",
};

const MODE_LABEL = { air: "空气", nitrox: "高氧", trimix: "Trimix" } as const;

type Filter = "all" | "confirmed" | "running" | "paused" | "alerts";

export default function OrderQueue() {
  const orders = useStore((s) => s.orders);
  const equipments = useStore((s) => s.equipments);
  const now = useStore((_s, t) => t);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [rescheduleTarget, setRescheduleTarget] = useState<Order | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<Order | null>(null);

  const eqName = (id: string) => equipments.find((e) => e.id === id)?.name ?? id;

  const filtered = useMemo(() => {
    return orders
      .filter((o) => {
        if (filter === "all") return true;
        if (filter === "confirmed") return o.status === "confirmed";
        if (filter === "running") return o.status === "inProgress" || o.status === "completed";
        if (filter === "paused") return o.status === "paused";
        if (filter === "alerts") return inspectionState(o.tank, now) !== "ok";
        return true;
      })
      .sort((a, b) => a.scheduledStart - b.scheduledStart);
  }, [orders, filter, now]);

  const act = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const counts = {
    confirmed: orders.filter((o) => o.status === "confirmed").length,
    running: orders.filter((o) => o.status === "inProgress" || o.status === "completed").length,
    paused: orders.filter((o) => o.status === "paused").length,
    alerts: orders.filter((o) => inspectionState(o.tank, now) !== "ok").length,
  };

  return (
    <section className="panel">
      <div className="heading">
        <div>
          <p>工单队列</p>
          <h2>待充填 / 作业中工单</h2>
        </div>
      </div>

      <div className="chips filter-chips">
        <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>
          全部 {orders.length}
        </button>
        <button className={filter === "confirmed" ? "on" : ""} onClick={() => setFilter("confirmed")}>
          待充填 {counts.confirmed}
        </button>
        <button className={filter === "running" ? "on" : ""} onClick={() => setFilter("running")}>
          作业中 {counts.running}
        </button>
        <button className={filter === "paused" ? "on" : ""} onClick={() => setFilter("paused")}>
          暂停保留 {counts.paused}
        </button>
        <button className={filter === "alerts" ? "on" : ""} onClick={() => setFilter("alerts")}>
          检验提醒 {counts.alerts}
        </button>
      </div>

      <div className="order-list">
        {filtered.map((o) => {
          const eq = equipments.find((e) => e.id === o.equipmentId);
          const insp = inspectionState(o.tank, now);
          const mix = mixHint(o.fillMode, o.tank.oxygenPct, o.tank.heliumPct);
          const open = expanded === o.id;
          const maint = eq ? isMaintenanceAt(eq, now) : false;
          const totalPause = o.pauseHistory.reduce((s, p) => s + (p.durationMs ?? 0), 0);
          const livePause =
            o.status === "paused" && o.activePause ? now - o.activePause.pausedAt : 0;
          return (
            <article key={o.id} className={`order-card status-${o.status}`}>
              <header className="order-head" onClick={() => setExpanded(open ? null : o.id)}>
                <div className="order-title">
                  <h3>{o.no}</h3>
                  <span className={`status-badge ${o.status}`}>{STATUS_LABEL[o.status]}</span>
                  {o.rescheduleCount > 0 && (
                    <span className="rsch-tag" title={`${o.lastRescheduleReason ?? ""}（客户改约 ${o.customerRescheduleCount} 次）`}>
                      改约 {o.rescheduleCount} 次
                    </span>
                  )}
                </div>
                <div className="order-meta">
                  <span>{eqName(o.equipmentId)}</span>
                  <span>{fmt(o.scheduledStart)} · {o.scheduledDurationMin}分钟</span>
                  <span>{MODE_LABEL[o.fillMode]} · 操作员 {o.operator}</span>
                </div>
              </header>

              <div className="order-body">
                <div className="tank-line">
                  <b>{o.tank.tankNo}</b>
                  <span>{o.tank.volumeL}L</span>
                  <span>
                    {o.tank.residualBar} → {o.tank.targetBar}bar
                  </span>
                  <span className={mix.ok ? "mix-ok" : "mix-warn"}>{mix.text}</span>
                  <span className={`insp ${insp}`}>
                    {insp === "expired"
                      ? `⚠ 检验已过期（${o.tank.inspectionExpiry}）`
                      : insp === "soon"
                        ? `检验有效期临近（${o.tank.inspectionExpiry}）`
                        : `检验有效至 ${o.tank.inspectionExpiry}`}
                  </span>
                </div>

                {o.status === "paused" && o.activePause && (
                  <div className="pause-box">
                    <b>现场保留中</b>
                    <span>
                      暂停原因：{o.activePause.reason} · 暂停前压力{" "}
                      {o.activePause.pressureAtPauseBar}bar
                    </span>
                    <span>已暂停 {fmtDuration(livePause)}（解锁时结算并按此进度恢复）</span>
                  </div>
                )}

                {o.pauseHistory.length > 0 && (
                  <div className="pause-history">
                    {o.pauseHistory.map((p, i) => (
                      <p key={i} className="small muted">
                        第 {i + 1} 次暂停：{fmt(p.pausedAt)} → {p.resumedAt ? fmt(p.resumedAt) : "—"}，
                        时长 {fmtDuration(p.durationMs ?? livePause)}，恢复压力 {p.pressureAtPauseBar}bar
                      </p>
                    ))}
                    {totalPause > 0 && (
                      <p className="small muted">累计暂停 {fmtDuration(totalPause)}</p>
                    )}
                  </div>
                )}

                {o.customer && (
                  <p className="customer-line small">
                    客户：{o.customer.customerName} · {o.customer.contact}
                    {o.customerRescheduleCount >= 2 && (
                      <em className="lock-note">
                        （客户已改约 {o.customerRescheduleCount} 次，后续改约沿用首次确认信息：
                        {o.customer.firstConfirmedName} / {o.customer.firstConfirmedContact}）
                      </em>
                    )}
                  </p>
                )}

                {o.status === "inProgress" && (
                  <div className="progress-bar">
                    <i
                      style={{
                        width: `${
                          ((o.currentPressureBar - o.tank.residualBar) /
                            Math.max(1, o.tank.targetBar - o.tank.residualBar)) *
                          100
                        }%`,
                      }}
                    />
                    <span>
                      当前 {o.currentPressureBar}bar / 目标 {o.tank.targetBar}bar
                    </span>
                  </div>
                )}

                <div className="order-actions">
                  {o.status === "confirmed" && (
                    <>
                      <button
                        className="primary"
                        disabled={maint}
                        title={maint ? "设备维护中，待解锁恢复后作业" : ""}
                        onClick={() =>
                          act(() => setState(startFill(getState(), o.id, getNow())))
                        }
                      >
                        开始充填
                      </button>
                      <button
                        onClick={() =>
                          o.customer
                            ? setRescheduleTarget(o)
                            : setConfirmTarget(o)
                        }
                      >
                        {o.customer ? "客户改约" : "首次客户确认"}
                      </button>
                    </>
                  )}
                  {o.status === "inProgress" && (
                    <>
                      <button
                        onClick={() => {
                          const v = window.prompt("记录当前压力 bar", String(o.tank.targetBar));
                          if (v === null) return;
                          const n = Number(v);
                          if (Number.isNaN(n)) return alert("请输入数字");
                          act(() =>
                            setState(
                              logPressure(getState(), o.id, getNow(), n, "现场记录"),
                            ),
                          );
                        }}
                      >
                        记录压力
                      </button>
                      <button onClick={() => act(() => setState(completeFill(getState(), o.id, getNow())))}>
                        充填完成
                      </button>
                    </>
                  )}
                  {o.status === "completed" && (
                    <button
                      className="primary"
                      onClick={() =>
                        act(() =>
                          setState(
                            signOrder(
                              getState(),
                              o.id,
                              getNow(),
                              o.customer?.customerName ?? "",
                            ),
                          ),
                        )
                      }
                    >
                      客户签收
                    </button>
                  )}
                  {o.status === "signed" && <span className="signed-note">✓ {fmt(o.signedAt ?? 0)} 已签收</span>}
                  <button className="ghost" onClick={() => setExpanded(open ? null : o.id)}>
                    {open ? "收起历史" : "工单历史"}
                  </button>
                </div>

                {open && (
                  <ul className="event-log">
                    {[...o.events].reverse().map((e) => (
                      <li key={e.id}>
                        <time>{fmt(e.t)}</time>
                        <span>{e.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </article>
          );
        })}
        {filtered.length === 0 && <p className="muted">该分类下暂无工单。</p>}
      </div>

      {rescheduleTarget && (
        <RescheduleDialog
          order={orders.find((o) => o.id === rescheduleTarget.id)!}
          onClose={() => setRescheduleTarget(null)}
        />
      )}
      {confirmTarget && (
        <ConfirmDialog
          order={orders.find((o) => o.id === confirmTarget.id)!}
          onClose={() => setConfirmTarget(null)}
        />
      )}
    </section>
  );
}

function ConfirmDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>首次客户确认 · {order.no}</h3>
        <p className="muted small">首次确认的姓名与联系方式将作为快照，改约满两次后强制沿用。</p>
        <label>
          <span>客户姓名</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>联系方式</span>
          <input value={contact} onChange={(e) => setContact(e.target.value)} />
        </label>
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={() => {
              if (!name.trim() || !contact.trim()) return alert("请填写完整");
              setState(confirmCustomer(getState(), order.id, name.trim(), contact.trim(), getNow()));
              onClose();
            }}
          >
            确认
          </button>
        </div>
      </div>
    </div>
  );
}

function RescheduleDialog({ order, onClose }: { order: Order; onClose: () => void }) {
  const forced = order.customerRescheduleCount >= 2;
  // 默认选择：当前计划时间之后 30 分钟
  const dt = new Date(order.scheduledStart + 30 * MIN);
  const localInput = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
    dt.getDate(),
  ).padStart(2, "0")}T${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
  const [when, setWhen] = useState(localInput);
  // 锁定后界面直接显示首次快照
  const [name, setName] = useState(
    forced ? order.customer!.firstConfirmedName : order.customer?.customerName ?? "",
  );
  const [contact, setContact] = useState(
    forced ? order.customer!.firstConfirmedContact : order.customer?.contact ?? "",
  );

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>客户改约 · {order.no}</h3>
        <p className="small">
          客户已改约 <b>{order.customerRescheduleCount}</b> 次（维护自动改约不计入）。
          {forced
            ? " 已满两次，本次起强制沿用首次确认信息，姓名与联系方式不可修改。"
            : " 未满两次，可更新联系方式（本次为第 " + (order.customerRescheduleCount + 1) + " 次客户改约）。"}
        </p>
        <label>
          <span>期望时间（若同设备时段被占用，自动取最近可用时段）</span>
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
        <fieldset className="confirm-fields" disabled={forced}>
          <label>
            <span>客户姓名{forced && "（锁定）"}</span>
            <input value={forced ? order.customer!.firstConfirmedName : name} readOnly={forced} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>联系方式{forced && "（锁定）"}</span>
            <input value={forced ? order.customer!.firstConfirmedContact : contact} readOnly={forced} onChange={(e) => setContact(e.target.value)} />
          </label>
        </fieldset>
        {forced && (
          <p className="lock-note">
            沿用首次确认：{order.customer!.firstConfirmedName} / {order.customer!.firstConfirmedContact}
          </p>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={() => {
              const t = new Date(when).getTime();
              if (Number.isNaN(t)) return alert("时间无效");
              const { state: next } = rescheduleOrder(
                getState(),
                order.id,
                t,
                getNow(),
                forced ? undefined : { name: name.trim(), contact: contact.trim() },
              );
              setState(next);
              onClose();
            }}
          >
            确认改约
          </button>
        </div>
      </div>
    </div>
  );
}
