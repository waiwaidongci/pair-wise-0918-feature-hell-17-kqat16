import { fmt } from "../domain";
import { useStore } from "../store";

export default function AuditLog() {
  const entries = useStore((s) => s.audit);
  return (
    <section className="panel audit-panel">
      <div className="heading">
        <div>
          <p>一致性追踪</p>
          <h2>工单历史与审计</h2>
        </div>
        <span className="muted small">最近 {entries.length} 条</span>
      </div>
      {entries.length === 0 ? (
        <p className="muted">暂无系统事件。对设备上锁/解锁或改约后，此处与工单历史同步留痕。</p>
      ) : (
        <ul className="audit-list">
          {entries.slice(0, 30).map((e) => (
            <li key={e.id} className={e.level}>
              <time>{fmt(e.t)}</time>
              <span>{e.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
