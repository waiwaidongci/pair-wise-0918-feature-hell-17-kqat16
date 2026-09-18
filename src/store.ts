// 全局状态：useSyncExternalStore + localStorage 持久化 + 可控时钟

import { useSyncExternalStore } from "react";
import type { Order, State } from "./types";
import { DAY, HOUR, MIN, addEvent, uid } from "./domain";

const STORAGE_KEY = "dive-fill-state-v1";

// 基准“现在”：用固定日期方便演示，可从 localStorage 恢复
const BASE_NOW = new Date("2026-09-18T09:00:00").getTime();

let now: number = BASE_NOW;
let state: State = load() ?? seed();
const listeners = new Set<() => void>();

export function getNow(): number {
  return now;
}

/** 以分钟为单位推进演示时钟（维护超时模拟用） */
export function advanceClock(min: number): void {
  now += min * MIN;
  emit();
}

export function setClock(t: number): void {
  now = t;
  emit();
}

function emit(): void {
  persist();
  listeners.forEach((l) => l());
}

export function getState(): State {
  return state;
}

export function setState(next: State): void {
  state = next;
  emit();
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useStore<T>(selector: (s: State, now: number) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state, now),
    () => selector(state, now),
  );
}

export function resetAll(): void {
  now = BASE_NOW;
  state = seed();
  emit();
}

// ---------------------------------------------------------------------------
// 种子数据
// ---------------------------------------------------------------------------

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function seed(): State {
  const t = BASE_NOW;
  const equipments = [
    { id: "comp1", name: "1号压缩机", kind: "compressor" as const, maintenance: null },
    { id: "comp2", name: "2号压缩机", kind: "compressor" as const, maintenance: null },
    { id: "pump1", name: "充填泵 A", kind: "fillPump" as const, maintenance: null },
    { id: "pump2", name: "充填泵 B", kind: "fillPump" as const, maintenance: null },
  ];

  const mk = (p: {
    no: string;
    equipmentId: string;
    startOffsetMin: number;
    durationMin: number;
    mode: Order["fillMode"];
    operator: string;
    tank: Order["tank"];
    status?: Order["status"];
    customer?: { name: string; contact: string };
  }): Order => {
    const scheduledStart = t + p.startOffsetMin * MIN;
    const o: Order = {
      id: uid("ord"),
      no: p.no,
      equipmentId: p.equipmentId,
      fillMode: p.mode,
      operator: p.operator,
      tank: p.tank,
      scheduledStart,
      scheduledDurationMin: p.durationMin,
      status: p.status ?? "confirmed",
      startedAt: null,
      completedAt: null,
      signedAt: null,
      currentPressureBar: p.tank.residualBar,
      progressLog: [],
      customer: p.customer
        ? {
            customerName: p.customer.name,
            contact: p.customer.contact,
            confirmedAt: t - DAY,
            firstConfirmedName: p.customer.name,
            firstConfirmedContact: p.customer.contact,
          }
        : null,
      rescheduleCount: 0,
      customerRescheduleCount: 0,
      lastRescheduleReason: null,
      pauseHistory: [],
      activePause: null,
      events: [
        {
          id: uid("ev"),
          t: t - 2 * HOUR,
          type: "created",
          detail: `工单创建，排班 ${new Date(scheduledStart).toLocaleString("zh-CN", { hour12: false })}`,
        },
      ],
      createdAt: t - 2 * HOUR,
    };
    if (p.customer) {
      o.events = addEvent(o.events, "customerConfirmed", t - DAY, `客户首次确认：${p.customer.name} / ${p.customer.contact}`);
    }
    return o;
  };

  const orders: Order[] = [
    mk({
      no: "F-2401",
      equipmentId: "comp1",
      startOffsetMin: 0,
      durationMin: 40,
      mode: "air",
      operator: "陈潜",
      tank: {
        tankNo: "TANK-204",
        volumeL: 12,
        inspectionExpiry: iso(new Date(t + 90 * DAY)),
        residualBar: 55,
        targetBar: 200,
        oxygenPct: 21,
        heliumPct: 0,
      },
      customer: { name: "王磊", contact: "138-0000-2041" },
    }),
    mk({
      no: "F-2402",
      equipmentId: "comp1",
      startOffsetMin: 50,
      durationMin: 35,
      mode: "nitrox",
      operator: "陈潜",
      tank: {
        tankNo: "TANK-219",
        volumeL: 11,
        inspectionExpiry: iso(new Date(t + 12 * DAY)),
        residualBar: 40,
        targetBar: 210,
        oxygenPct: 32,
        heliumPct: 0,
      },
      customer: { name: "李娜", contact: "139-0000-2192" },
    }),
    mk({
      no: "F-2403",
      equipmentId: "comp1",
      startOffsetMin: 100,
      durationMin: 45,
      mode: "trimix",
      operator: "周海",
      tank: {
        tankNo: "TANK-231",
        volumeL: 24,
        inspectionExpiry: iso(new Date(t - 3 * DAY)),
        residualBar: 30,
        targetBar: 220,
        oxygenPct: 18,
        heliumPct: 35,
      },
      status: "confirmed",
      customer: { name: "赵鹏", contact: "137-0000-2313" },
    }),
    mk({
      no: "F-2404",
      equipmentId: "pump1",
      startOffsetMin: 10,
      durationMin: 30,
      mode: "nitrox",
      operator: "周海",
      tank: {
        tankNo: "TANK-188",
        volumeL: 12,
        inspectionExpiry: iso(new Date(t + 200 * DAY)),
        residualBar: 60,
        targetBar: 200,
        oxygenPct: 36,
        heliumPct: 0,
      },
      customer: { name: "孙莉", contact: "136-0000-1884" },
    }),
    mk({
      no: "F-2405",
      equipmentId: "comp2",
      startOffsetMin: -15,
      durationMin: 50,
      mode: "air",
      operator: "陈潜",
      tank: {
        tankNo: "TANK-150",
        volumeL: 15,
        inspectionExpiry: iso(new Date(t + 365 * DAY)),
        residualBar: 50,
        targetBar: 200,
        oxygenPct: 21,
        heliumPct: 0,
      },
      status: "inProgress",
      customer: { name: "吴凯", contact: "135-0000-1505" },
    }),
  ];

  // 让 F-2405 已经进行了一段时间、压力上升
  const f2405 = orders.find((o) => o.no === "F-2405")!;
  f2405.startedAt = t - 15 * MIN;
  f2405.currentPressureBar = 120;
  f2405.progressLog = [
    { t: t - 15 * MIN, pressureBar: 50, note: "开始充填" },
    { t: t - 5 * MIN, pressureBar: 120, note: "阶段记录" },
  ];
  f2405.events = addEvent(f2405.events, "fillStarted", t - 15 * MIN, "开始充填，起始压力 50bar");
  f2405.events = addEvent(f2405.events, "pressureLogged", t - 5 * MIN, "压力 120bar（阶段记录）");

  return { version: 1, equipments, orders, audit: [], seededAt: t };
}

function load(): State | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state: State; now: number };
    now = parsed.now ?? BASE_NOW;
    return parsed.state;
  } catch {
    return null;
  }
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ state, now }));
  } catch {
    // 忽略持久化失败
  }
}
