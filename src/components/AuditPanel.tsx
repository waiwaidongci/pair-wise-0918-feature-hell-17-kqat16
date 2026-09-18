import { useMemo } from "react";
import { useStore, fmtTime } from "../store";
import { findConsistencyIssues } from "../scheduling";

export default function AuditPanel() {
  const { state, dispatch } = useStore();
  const issues = useMemo(() => findConsistencyIssues(state), [state]);

  return (
    <section className="panel audit-panel">
      <div className="heading">
        <div>
          <p>一致性审计</p>
          <h2>设备状态 · 工单历史 · 排班</h2>
        </div>
        <button onClick={() => dispatch({ type: "RESET" })}>重置演示数据</button>
      </div>

      <div className={`consistency ${issues.length === 0 ? "ok" : "bad"}`}>
        {issues.length === 0 ? (
          <>
            <strong>✅ 三方数据一致</strong>
            <span>
              所有设备状态均由工单与维护锁派生；同设备工单时段无重叠；维护窗口内无未接管工单；
              两次改约后的工单确认信息与首次快照一致。
            </span>
          </>
        ) : (
          <>
            <strong>⛔ 发现 {issues.length} 处不一致</strong>
            <ul>
              {issues.map((i, idx) => (
                <li key={idx}>{i.message}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      <h3 className="log-title">操作与自动调度日志</h3>
      <div className="log-list">
        {state.log.map((ev) => (
          <div key={ev.id} className={`log-item log-${ev.category}`}>
            <time>{fmtTime(ev.t)}</time>
            <span className="log-tag">
              {ev.category === "maintenance"
                ? "维护锁"
                : ev.category === "order"
                ? "工单"
                : "系统"}
            </span>
            <p>{ev.message}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
