import { useMemo, useState } from "react";
import {
  useStore,
  fmtTime,
  toLocalInputValue,
  mixHint,
  inspectionStatus,
} from "../store";
import { findNearestSlot, slotHasConflict } from "../scheduling";
import type { FillMethod } from "../types";

const METHODS: FillMethod[] = ["空气", "高氧", "Trimix"];

export default function NewOrderForm() {
  const { state, dispatch } = useStore();
  const [tankNo, setTankNo] = useState("");
  const [volume, setVolume] = useState("12L 铝瓶");
  const [equipmentId, setEquipmentId] = useState(state.equipment[0]?.id ?? "");
  const [durationMin, setDurationMin] = useState(40);
  const [startInput, setStartInput] = useState(
    toLocalInputValue(state.now + 30 * 60_000)
  );
  const [residual, setResidual] = useState(50);
  const [target, setTarget] = useState(200);
  const [method, setMethod] = useState<FillMethod>("空气");
  const [o2, setO2] = useState(21);
  const [he, setHe] = useState(0);
  const [contact, setContact] = useState("");
  const [phone, setPhone] = useState("");
  const [operator, setOperator] = useState("陈潜");
  const [error, setError] = useState("");

  const requestedStart = useMemo(() => {
    const t = new Date(startInput).getTime();
    return Number.isFinite(t) ? t : state.now;
  }, [startInput, state.now]);

  const inspectionDays = 365;
  const inspectionExpiry = state.now + inspectionDays * 86_400_000;

  const mix = mixHint(o2, he, method);
  const recommendation = useMemo(
    () =>
      findNearestSlot(
        state,
        equipmentId,
        durationMin,
        Math.max(state.now, requestedStart)
      ),
    [state, equipmentId, durationMin, requestedStart]
  );
  const useRecommended =
    recommendation.start !== requestedStart ||
    slotHasConflict(state, equipmentId, requestedStart, requestedStart + durationMin * 60_000);

  function submit() {
    setError("");
    if (!tankNo.trim()) return setError("请填写气瓶编号");
    if (!contact.trim() || !phone.trim()) return setError("请填写客户姓名与联系电话");
    if (target <= residual) return setError("目标压力必须大于残压");
    if (o2 < 0 || he < 0 || o2 + he > 100) return setError("混合气配比无效（O₂ + He 不能超过 100%）");
    if (inspectionExpiry < state.now) return setError("气瓶检验已过期，不能创建充填工单");

    const start = useRecommended ? recommendation.start : requestedStart;
    const end = start + durationMin * 60_000;
    dispatch({
      type: "CREATE_ORDER",
      order: {
        tankNo: tankNo.trim(),
        volume,
        inspectionExpiry,
        residualPressure: residual,
        targetPressure: target,
        o2,
        he,
        fillMethod: method,
        operator,
        contactName: contact.trim(),
        phone: phone.trim(),
        equipmentId,
        start,
        end,
        durationMin,
      },
    });
    setTankNo("");
    setContact("");
    setPhone("");
  }

  const chosenEquipment = state.equipment.find((e) => e.id === equipmentId);
  const underMaintenance = state.maintenance.some(
    (m) => m.equipmentId === equipmentId && m.end === null
  );

  return (
    <section className="panel form-panel">
      <div className="heading">
        <div>
          <p>新工单</p>
          <h2>登记气瓶充填</h2>
        </div>
      </div>

      <div className="field-grid">
        <label>
          <span>气瓶编号</span>
          <input value={tankNo} onChange={(e) => setTankNo(e.target.value)} placeholder="如 TANK-240" />
        </label>
        <label>
          <span>容积 / 瓶型</span>
          <input value={volume} onChange={(e) => setVolume(e.target.value)} />
        </label>
        <label>
          <span>充填设备</span>
          <select value={equipmentId} onChange={(e) => setEquipmentId(e.target.value)}>
            {state.equipment.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}（{e.id}）
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>充填时长（分钟）</span>
          <input
            type="number"
            min={5}
            step={5}
            value={durationMin}
            onChange={(e) => setDurationMin(Number(e.target.value))}
          />
        </label>
        <label>
          <span>期望开始时间</span>
          <input
            type="datetime-local"
            value={startInput}
            onChange={(e) => setStartInput(e.target.value)}
          />
        </label>
        <label>
          <span>操作员</span>
          <input value={operator} onChange={(e) => setOperator(e.target.value)} />
        </label>
        <label>
          <span>残压（bar）</span>
          <input type="number" value={residual} onChange={(e) => setResidual(Number(e.target.value))} />
        </label>
        <label>
          <span>目标压力（bar）</span>
          <input type="number" value={target} onChange={(e) => setTarget(Number(e.target.value))} />
        </label>
        <label>
          <span>充填方式</span>
          <select
            value={method}
            onChange={(e) => {
              const m = e.target.value as FillMethod;
              setMethod(m);
              if (m === "空气") {
                setO2(21);
                setHe(0);
              } else if (m === "高氧") {
                setHe(0);
                if (o2 === 21) setO2(32);
              }
            }}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>氧含量 O₂（%）</span>
          <input type="number" value={o2} step={0.5} onChange={(e) => setO2(Number(e.target.value))} />
        </label>
        <label>
          <span>氦含量 He（%）</span>
          <input
            type="number"
            value={he}
            step={0.5}
            disabled={method !== "Trimix"}
            onChange={(e) => setHe(Number(e.target.value))}
          />
        </label>
        <label>
          <span>氮气 N₂（%，自动计算）</span>
          <input value={`${mix.n2}%`} readOnly />
        </label>
        <label>
          <span>客户姓名</span>
          <input value={contact} onChange={(e) => setContact(e.target.value)} />
        </label>
        <label>
          <span>联系电话</span>
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
      </div>

      <div className="mix-box">
        🧪 混合气：{method}
        {method === "Trimix"
          ? ` O₂ ${o2}% / He ${he}% / N₂ ${mix.n2}%`
          : ` O₂ ${o2}% / N₂ ${mix.n2}%`}
        {mix.warnings.map((w) => (
          <em key={w} className="mix-warn">· {w}</em>
        ))}
      </div>

      <div className={`slot-hint ${useRecommended ? "slot-moved" : "slot-ok"}`}>
        {underMaintenance ? (
          <>
            ⚠️ {chosenEquipment?.name} 维护锁定中，系统已避开维护窗口推荐时段。
          </>
        ) : useRecommended ? (
          <>
            期望时段与现有排班/维护窗口冲突，已为该工单推荐最近可用时段：
            <b> {fmtTime(recommendation.start)} – {fmtTime(recommendation.end)}</b>
          </>
        ) : (
          <>
            ✅ 期望时段可用：<b>{fmtTime(requestedStart)} – {fmtTime(
              requestedStart + durationMin * 60_000
            )}</b>
          </>
        )}
      </div>

      {inspectionStatus(inspectionExpiry, state.now) !== "ok" && (
        <div className="alert alert-expired">检验有效期异常，无法创建工单</div>
      )}
      {error && <div className="alert alert-expired">{error}</div>}

      <button className="primary submit-btn" onClick={submit}>
        保存记录并排入排班
      </button>
      <p className="hint">保存即生成客户首次确认信息快照；后续改约两次后将强制沿用该快照。</p>
    </section>
  );
}
