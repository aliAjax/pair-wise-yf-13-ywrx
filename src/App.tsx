import { useEffect, useMemo, useState } from "react";
import "./styles.css";

const project = {
  sourceNo: 1,
  id: "hxyfront-62001",
  port: 62001,
  title: "船舶轮机值班记录",
};

/* ---------------------------------- 领域配置 ---------------------------------- */

type Category = "主机" | "发电机" | "泵组" | "舱底水";

interface ReadingSpec {
  key: string;
  label: string;
  unit: string;
  min: number;
  max: number;
}

interface DeviceDef {
  id: string;
  name: string;
  category: Category;
  specs: ReadingSpec[];
}

// 每班固定巡检序列：主机 → 发电机 → 泵组 → 舱底水，顺序即签点顺序
const ROUTE: DeviceDef[] = [
  {
    id: "me",
    name: "主机",
    category: "主机",
    specs: [
      { key: "rpm", label: "主机转速", unit: "rpm", min: 60, max: 120 },
      { key: "lube", label: "滑油压力", unit: "MPa", min: 0.3, max: 0.6 },
      { key: "cool", label: "冷却水温", unit: "℃", min: 60, max: 85 },
      { key: "fuel", label: "燃油消耗", unit: "t", min: 0, max: 5 },
    ],
  },
  {
    id: "dg1",
    name: "发电机#1",
    category: "发电机",
    specs: [
      { key: "cool", label: "冷却水温", unit: "℃", min: 55, max: 90 },
      { key: "lube", label: "滑油压力", unit: "MPa", min: 0.25, max: 0.55 },
      { key: "power", label: "输出功率", unit: "kW", min: 0, max: 800 },
    ],
  },
  {
    id: "dg2",
    name: "发电机#2",
    category: "发电机",
    specs: [
      { key: "cool", label: "冷却水温", unit: "℃", min: 55, max: 90 },
      { key: "lube", label: "滑油压力", unit: "MPa", min: 0.25, max: 0.55 },
      { key: "power", label: "输出功率", unit: "kW", min: 0, max: 800 },
    ],
  },
  {
    id: "swp",
    name: "海水冷却泵",
    category: "泵组",
    specs: [{ key: "pressure", label: "出口压力", unit: "MPa", min: 0.15, max: 0.4 }],
  },
  {
    id: "lop",
    name: "滑油泵",
    category: "泵组",
    specs: [{ key: "pressure", label: "出口压力", unit: "MPa", min: 0.15, max: 0.4 }],
  },
  {
    id: "fp",
    name: "燃油供给泵",
    category: "泵组",
    specs: [{ key: "pressure", label: "出口压力", unit: "MPa", min: 0.15, max: 0.4 }],
  },
  {
    id: "bilge",
    name: "舱底水",
    category: "舱底水",
    specs: [
      { key: "level", label: "液位", unit: "%", min: 0, max: 80 },
      { key: "temp", label: "舱底水温", unit: "℃", min: 10, max: 50 },
    ],
  },
];

const DEVICE_MAP: Record<string, DeviceDef> = Object.fromEntries(ROUTE.map((d) => [d.id, d]));

// 固定六班四小时制
const SHIFTS = [
  { id: "00-04", label: "00-04班" },
  { id: "04-08", label: "04-08班" },
  { id: "08-12", label: "08-12班" },
  { id: "12-16", label: "12-16班" },
  { id: "16-20", label: "16-20班" },
  { id: "20-24", label: "20-24班" },
];

const FILTERS: Array<"全部" | Category> = ["全部", "主机", "发电机", "泵组", "舱底水"];
const STORAGE_KEY = "hxyfront-62001/inspection-closure/v1";

/* ---------------------------------- 数据类型 ---------------------------------- */

type Reading = Record<string, string>;
type EventKind = "sign" | "reject" | "miss" | "review" | "handover" | "status";

interface Checkpoint {
  deviceId: string;
  time: string;
  readings: Reading;
}

interface MissReview {
  time: string;
  reviewer: string;
  status: "confirmed" | "rejected";
  note: string;
}

interface Miss {
  id: string;
  deviceId: string;
  time: string;
  reason: string;
  review: MissReview | null;
}

interface TimelineEvent {
  id: string;
  time: string;
  kind: EventKind;
  deviceId?: string;
  text: string;
}

interface Handover {
  time: string;
  note: string;
}

interface ShiftState {
  checkpoints: Checkpoint[];
  misses: Miss[];
  events: TimelineEvent[];
  handover: Handover | null;
}

interface PersistedData {
  version: 1;
  shifts: Record<string, ShiftState>;
  running: Record<string, boolean>;
  filter: "全部" | Category;
}

const emptyShift = (): ShiftState => ({ checkpoints: [], misses: [], events: [], handover: null });

/* ---------------------------------- 纯业务规则 ---------------------------------- */

const isPendingMiss = (m: Miss): boolean => m.review === null || m.review.status === "rejected";

const deviceDone = (s: ShiftState, deviceId: string): boolean =>
  s.checkpoints.some((c) => c.deviceId === deviceId) || s.misses.some((m) => m.deviceId === deviceId);

// 固定序列中第一台既未签点也未登记漏检的设备 = 当前唯一可操作设备（未到顺序不可提前签）
const nextDeviceId = (s: ShiftState): string | null => {
  const d = ROUTE.find((dev) => !deviceDone(s, dev.id));
  return d ? d.id : null;
};

// 读数校验：缺填 / 非数值 / 越界均列出；返回空数组表示通过
const validateReadings = (device: DeviceDef, readings: Reading): string[] => {
  const errors: string[] = [];
  device.specs.forEach((spec) => {
    const raw = (readings[spec.key] ?? "").trim();
    if (raw === "") {
      errors.push(`${spec.label}未填写`);
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      errors.push(`${spec.label}「${raw}」不是有效数值`);
    } else if (n < spec.min || n > spec.max) {
      errors.push(`${spec.label} ${raw}${spec.unit} 越界（允许 ${spec.min}~${spec.max}${spec.unit}）`);
    }
  });
  return errors;
};

// 交接闭环：路线走完且没有待复核（未复核或被驳回）漏检
const handoverBlockers = (s: ShiftState): string[] => {
  const reasons: string[] = [];
  const remaining = ROUTE.length - s.checkpoints.length - s.misses.length;
  if (nextDeviceId(s) !== null) reasons.push(`还有 ${remaining} 台设备未完成签点/漏检登记`);
  const pending = s.misses.filter(isPendingMiss).length;
  if (pending > 0) reasons.push(`有 ${pending} 条漏检仍待交班复核`);
  return reasons;
};

export const __rules = {
  ROUTE,
  emptyShift,
  nextDeviceId,
  validateReadings,
  handoverBlockers,
  isPending: isPendingMiss,
};

/* ---------------------------------- 工具函数 ---------------------------------- */

const uid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const todayStr = (): string => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};

const defaultWatchIdx = (): number => {
  const idx = Math.floor(new Date().getHours() / 4);
  return Math.min(idx, SHIFTS.length - 1);
};

const hm = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const mdhm = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm(iso)}`;
};

const loadData = (): PersistedData => {
  const fallback: PersistedData = {
    version: 1,
    shifts: {},
    running: Object.fromEntries(ROUTE.map((d) => [d.id, true])),
    filter: "全部",
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as PersistedData;
    return {
      version: 1,
      shifts: parsed.shifts ?? {},
      running: { ...fallback.running, ...(parsed.running ?? {}) },
      filter: parsed.filter ?? "全部",
    };
  } catch {
    return fallback;
  }
};

/* ---------------------------------- 主组件 ---------------------------------- */

function App() {
  const [data, setData] = useState<PersistedData>(loadData);
  const [dateStr, setDateStr] = useState<string>(todayStr);
  const [watchIdx, setWatchIdx] = useState<number>(defaultWatchIdx);

  const [drafts, setDrafts] = useState<Reading>({});
  const [missReason, setMissReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, { reviewer: string; note: string }>>({});
  const [reedit, setReedit] = useState<{ id: string; text: string } | null>(null);
  const [note, setNote] = useState("");

  const shift = SHIFTS[watchIdx];
  const shiftKey = `${dateStr}__${shift.id}`;
  const current: ShiftState = data.shifts[shiftKey] ?? emptyShift();
  const locked = current.handover !== null;
  const filter = data.filter;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* 本地存储不可用时仅保留内存状态 */
    }
  }, [data]);

  const missByDevice = useMemo(() => {
    const map = new Map<string, Miss>();
    current.misses.forEach((m) => map.set(m.deviceId, m));
    return map;
  }, [current]);

  // 路线上第一台既未签点也未登记漏检的设备 = 当前唯一可操作设备
  const nextDevice = (() => {
    const id = nextDeviceId(current);
    return id ? DEVICE_MAP[id] : null;
  })();

  const pendingMisses = current.misses.filter(isPendingMiss);
  const routeDone = !nextDevice;
  const blockReasons = handoverBlockers(current);
  const canHandover = blockReasons.length === 0;

  // 切换班次/日期时重置全部表单
  useEffect(() => {
    setDrafts({});
    setMissReason("");
    setError(null);
    setReedit(null);
    setReviewDrafts({});
    setNote(current.handover?.note ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shiftKey]);

  // 当前可签点设备推进时，只清空签点表单
  useEffect(() => {
    setDrafts({});
    setMissReason("");
    setError(null);
    setReedit(null);
  }, [nextDevice?.id]);

  const updateShift = (fn: (s: ShiftState) => ShiftState) =>
    setData((prev) => ({
      ...prev,
      shifts: { ...prev.shifts, [shiftKey]: fn(prev.shifts[shiftKey] ?? emptyShift()) },
    }));

  const pushEvent = (s: ShiftState, kind: EventKind, text: string, deviceId?: string): ShiftState => ({
    ...s,
    events: [...s.events, { id: uid(), time: new Date().toISOString(), kind, text, ...(deviceId ? { deviceId } : {}) }],
  });

  /* 签点：设备未启动或任一读数越界/无效 → 整次拒绝，不产生签点，路线与看板不变 */
  const signNext = () => {
    const device = nextDevice;
    if (!device || locked) return;
    if (data.running[device.id] === false) {
      const text = `${device.name} 未启动，整次签点已拒绝（路线与看板不变）`;
      updateShift((s) => pushEvent(s, "reject", text, device.id));
      setError(text);
      return;
    }
    const readings: Reading = {};
    device.specs.forEach((spec) => {
      readings[spec.key] = (drafts[spec.key] ?? "").trim();
    });
    const errors = validateReadings(device, readings);
    if (errors.length > 0) {
      const text = `${device.name} 读数异常，整次签点已拒绝：${errors.join("；")}`;
      updateShift((s) => pushEvent(s, "reject", text, device.id));
      setError(text + "；原路线与看板不变。");
      return;
    }
    const time = new Date().toISOString();
    updateShift((s) =>
      pushEvent(
        { ...s, checkpoints: [...s.checkpoints, { deviceId: device.id, time, readings }] },
        "sign",
        `${device.name} 签点成功（${device.specs
          .map((sp) => `${sp.label} ${readings[sp.key]}${sp.unit}`)
          .join("，")}）`,
        device.id
      )
    );
    setError(null);
    setDrafts({});
  };

  /* 漏检登记：必须写明原因，登记后路线前进，进入交班复核队列 */
  const registerMiss = () => {
    const device = nextDevice;
    if (!device || locked) return;
    const reason = missReason.trim();
    if (!reason) {
      setError("漏检设备必须写明原因后才能登记。");
      return;
    }
    const time = new Date().toISOString();
    const miss: Miss = { id: uid(), deviceId: device.id, time, reason, review: null };
    updateShift((s) =>
      pushEvent(
        { ...s, misses: [...s.misses, miss] },
        "miss",
        `${device.name} 登记漏检：${reason}（待交班复核）`,
        device.id
      )
    );
    setError(null);
    setMissReason("");
  };

  const reviewMiss = (miss: Miss, status: "confirmed" | "rejected") => {
    if (locked) return;
    const draft = reviewDrafts[miss.id] ?? { reviewer: "", note: "" };
    const reviewer = draft.reviewer.trim() || "接班轮机员";
    const device = DEVICE_MAP[miss.deviceId];
    const time = new Date().toISOString();
    updateShift((s) => ({
      ...pushEvent(
        {
          ...s,
          misses: s.misses.map((m) =>
            m.id === miss.id ? { ...m, review: { time, reviewer, status, note: draft.note.trim() } } : m
          ),
        },
        "review",
        status === "confirmed"
          ? `${device.name} 漏检已经交班复核确认（复核人：${reviewer}${draft.note.trim() ? `，${draft.note.trim()}` : ""}）`
          : `${device.name} 漏检原因被复核驳回（复核人：${reviewer}${draft.note.trim() ? `，${draft.note.trim()}` : ""}），需补充原因重新提交`,
        miss.deviceId
      ),
    }));
    setReviewDrafts((prev) => {
      const next = { ...prev };
      delete next[miss.id];
      return next;
    });
  };

  // 驳回后的漏检：补充原因并重新提交，回到待复核状态
  const resubmitMiss = (miss: Miss) => {
    if (!reedit || reedit.id !== miss.id || locked) return;
    const reason = reedit.text.trim();
    if (!reason) {
      setError("补充原因不能为空。");
      return;
    }
    const device = DEVICE_MAP[miss.deviceId];
    updateShift((s) =>
      pushEvent(
        {
          ...s,
          misses: s.misses.map((m) => (m.id === miss.id ? { ...m, reason: `${m.reason}｜补充：${reason}`, review: null } : m)),
        },
        "miss",
        `${device.name} 补充漏检原因并重新提交复核：${reason}`,
        miss.deviceId
      )
    );
    setReedit(null);
    setError(null);
  };

  const toggleRunning = (device: DeviceDef) => {
    if (locked) return;
    setData((prev) => {
      const nextRunning = prev.running[device.id] === false;
      const running = { ...prev.running, [device.id]: nextRunning };
      return {
        ...prev,
        running,
        shifts: {
          ...prev.shifts,
          [shiftKey]: pushEvent(
            prev.shifts[shiftKey] ?? emptyShift(),
            "status",
            `${device.name} 标记为${nextRunning ? "运行" : "停用（未启动）"}`,
            device.id
          ),
        },
      };
    });
  };

  const completeHandover = () => {
    if (!canHandover || locked) return;
    const time = new Date().toISOString();
    updateShift((s) =>
      pushEvent(
        { ...s, handover: { time, note: note.trim() } },
        "handover",
        `交接完成：已签点 ${s.checkpoints.length}/${ROUTE.length}，漏检 ${s.misses.length} 项均已复核确认${
          note.trim() ? `。备注：${note.trim()}` : ""
        }`
      )
    );
  };

  /* 看板四项核心参数取本班主机签点读数 */
  const mainCp = current.checkpoints.find((c) => c.deviceId === "me") ?? null;
  const dashboardTiles = [
    { label: "主机转速", key: "rpm", unit: "rpm" },
    { label: "滑油压力", key: "lube", unit: "MPa" },
    { label: "冷却水温", key: "cool", unit: "℃" },
    { label: "燃油消耗", key: "fuel", unit: "t" },
  ];

  /* 当前班次时间线（按设备筛选） */
  const visibleEvents = current.events
    .filter(
      (e) => filter === "全部" || !e.deviceId || (DEVICE_MAP[e.deviceId]?.category === filter)
    )
    .sort((a, b) => a.time.localeCompare(b.time));

  /* 全班次历史记录（按设备筛选） */
  const history = useMemo(() => {
    type Item = { time: string; shiftLabel: string; kind: EventKind; deviceId?: string; lines: string[] };
    const items: Item[] = [];
    Object.entries(data.shifts).forEach(([key, s]) => {
      const [d, wid] = key.split("__");
      const shiftLabel = `${d} ${SHIFTS.find((x) => x.id === wid)?.label ?? wid}`;
      s.checkpoints.forEach((c) => {
        const dev = DEVICE_MAP[c.deviceId];
        if (filter !== "全部" && dev.category !== filter) return;
        items.push({
          time: c.time,
          shiftLabel,
          kind: "sign",
          deviceId: c.deviceId,
          lines: [
            `${dev.name} 已签点`,
            dev.specs.map((sp) => `${sp.label} ${c.readings[sp.key] ?? "—"}${sp.unit}`).join("，"),
          ],
        });
      });
      s.misses.forEach((m) => {
        const dev = DEVICE_MAP[m.deviceId];
        if (filter !== "全部" && dev.category !== filter) return;
        items.push({
          time: m.time,
          shiftLabel,
          kind: "miss",
          deviceId: m.deviceId,
          lines: [
            `${dev.name} 漏检${m.review ? (m.review.status === "confirmed" ? "（复核确认）" : "（复核驳回）") : "（待复核）"}`,
            `原因：${m.reason}`,
          ],
        });
      });
      if (s.handover && filter === "全部") {
        items.push({
          time: s.handover.time,
          shiftLabel,
          kind: "handover",
          lines: ["完成交接", s.handover.note ? `备注：${s.handover.note}` : "无交接备注"],
        });
      }
    });
    return items.sort((a, b) => b.time.localeCompare(a.time));
  }, [data.shifts, filter]);

  const exportSummary = () => {
    const lines: string[] = [];
    lines.push(`船舶轮机值班交接摘要`);
    lines.push(`班次：${dateStr} ${shift.label}`);
    lines.push(`状态：${locked ? `已于 ${mdhm(current.handover!.time)} 完成交接` : "未交接"}`);
    lines.push(`路线进度：已签点 ${current.checkpoints.length}/${ROUTE.length}，漏检 ${current.misses.length}`);
    lines.push("");
    ROUTE.forEach((d, i) => {
      const cp = current.checkpoints.find((c) => c.deviceId === d.id);
      const miss = missByDevice.get(d.id);
      let status: string;
      if (cp) {
        status = `已签点 ${hm(cp.time)}：${d.specs
          .map((sp) => `${sp.label}=${cp.readings[sp.key] ?? "—"}${sp.unit}`)
          .join("，")}`;
      } else if (miss) {
        status = `漏检，原因：${miss.reason}；复核：${
          miss.review
            ? `${miss.review.status === "confirmed" ? "确认" : "驳回"}（${miss.review.reviewer}）`
            : "待复核"
        }`;
      } else {
        status = "未签点";
      }
      lines.push(`${i + 1}. [${d.category}] ${d.name}：${status}`);
    });
    lines.push("");
    lines.push(`交接备注：${note.trim() || "（无）"}`);
    const blob = new Blob([lines.join("\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `交接摘要_${dateStr}_${shift.id}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const shiftDot = (s: ShiftState | undefined): string => {
    if (!s || s.events.length === 0) return "dot-empty";
    if (s.handover) return "dot-done";
    if (s.misses.some(isPendingMiss)) return "dot-warn";
    return "dot-active";
  };

  const eventTag: Record<EventKind, { text: string; cls: string }> = {
    sign: { text: "签点", cls: "tag-sign" },
    reject: { text: "拒绝", cls: "tag-reject" },
    miss: { text: "漏检", cls: "tag-miss" },
    review: { text: "复核", cls: "tag-review" },
    handover: { text: "交接", cls: "tag-handover" },
    status: { text: "状态", cls: "tag-status" },
  };

  return (
    <main className="app">
      <section className="hero">
        <p>{project.id} · 源提示词{project.sourceNo} · Port {project.port}</p>
        <h1>{project.title}</h1>
        <span>
          巡检路线签点闭环：每班按主机 → 发电机 → 泵组 → 舱底水固定顺序签点，读数越界或设备未启动整次拒绝；
          漏检须写明原因并经交班复核，仍有待复核漏检时不得完成交接。数据保存在浏览器本地，刷新后保留。
        </span>
      </section>

      <section className="metrics">
        {dashboardTiles.map((tile) => {
          const value = mainCp?.readings[tile.key];
          return (
            <article key={tile.key}>
              <small>{tile.label}（本班主机）</small>
              <strong>
                {value ?? "—"}
                {value ? <em>{tile.unit}</em> : ""}
              </strong>
              <small className="tile-sub">{mainCp ? `签点时间 ${hm(mainCp.time)}` : "主机尚未签点"}</small>
            </article>
          );
        })}
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>轮机设备筛选</h2>
          <div className="chips">
            {FILTERS.map((item) => (
              <button
                key={item}
                className={filter === item ? "active" : ""}
                onClick={() => setData((prev) => ({ ...prev, filter: item }))}
              >
                {item}
              </button>
            ))}
          </div>
          <p className="side-hint">筛选同时作用于巡检路线、异常时间线与历史记录。</p>

          <h2 className="side-title">设备运行状态</h2>
          <div className="runlist">
            {ROUTE.map((d) => (
              <div key={d.id} className="runrow">
                <span>
                  <i className={`cat-dot cat-${d.category}`} />
                  {d.name}
                </span>
                <button
                  role="switch"
                  aria-checked={data.running[d.id] !== false}
                  className={`switch ${data.running[d.id] === false ? "" : "on"} ${locked ? "locked" : ""}`}
                  disabled={locked}
                  onClick={() => toggleRunning(d)}
                  title={locked ? "本班已交接，状态锁定" : "点击切换运行 / 未启动"}
                >
                  {data.running[d.id] === false ? "未启动" : "运行"}
                </button>
              </div>
            ))}
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>固定班次 · 固定路线</p>
              <h2>值班巡检签点</h2>
            </div>
            <div className="route-stat">
              已签 <b>{current.checkpoints.length}</b>/{ROUTE.length} · 漏检 <b>{current.misses.length}</b> ·
              待复核 <b className={pendingMisses.length > 0 ? "warn-text" : ""}>{pendingMisses.length}</b>
            </div>
          </div>

          <div className="shiftbar">
            <label className="date-pick">
              <span>值班日期</span>
              <input type="date" value={dateStr} max={todayStr()} onChange={(e) => setDateStr(e.target.value)} />
            </label>
            <div className="shiftbtns">
              {SHIFTS.map((s, i) => {
                const key = `${dateStr}__${s.id}`;
                return (
                  <button
                    key={s.id}
                    className={`shift-btn ${i === watchIdx ? "active" : ""}`}
                    onClick={() => setWatchIdx(i)}
                  >
                    <i className={`status-dot ${shiftDot(data.shifts[key])}`} />
                    {s.label}
                  </button>
                );
              })}
            </div>
            {locked && <p className="locked-banner">本班次已于 {mdhm(current.handover!.time)} 完成交接，路线锁定不可再签。</p>}
          </div>

          {error && <div className="alert">{error}</div>}

          {nextDevice && !locked && filter !== "全部" && nextDevice.category !== filter && (
            <div className="filter-hint">
              当前待签设备为「{nextDevice.name}」（{nextDevice.category}），被筛选「{filter}」隐藏。切换到「全部」即可继续按顺序签点。
            </div>
          )}

          <ol className="route">
            {ROUTE.map((device, index) => {
              const cp = current.checkpoints.find((c) => c.deviceId === device.id);
              const miss = missByDevice.get(device.id);
              const isNext = nextDevice?.id === device.id;
              const hiddenByFilter = filter !== "全部" && device.category !== filter;
              if (hiddenByFilter) return null;

              const cls = cp ? "signed" : miss ? "missed" : isNext ? "current" : "locked";
              return (
                <li key={device.id} className={`route-card ${cls}`}>
                  <div className="route-head">
                    <span className="seq">{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <h3>
                        {device.name}
                        <small className="cat-tag">{device.category}</small>
                      </h3>
                      {cp && <span className="badge badge-sign">已签点 {hm(cp.time)}</span>}
                      {miss && (
                        <span className={`badge ${miss.review?.status === "confirmed" ? "badge-confirmed" : miss.review?.status === "rejected" ? "badge-rejected" : "badge-miss"}`}>
                          漏检{miss.review ? (miss.review.status === "confirmed" ? "·已确认" : "·已驳回") : "·待复核"}
                        </span>
                      )}
                      {!cp && !miss && !isNext && <span className="badge badge-lock">顺序未到</span>}
                      {isNext && !locked && <span className="badge badge-current">当前签点</span>}
                    </div>
                  </div>

                  {cp && (
                    <ul className="reading-list">
                      {device.specs.map((sp) => (
                        <li key={sp.key}>
                          {sp.label}：<b>{cp.readings[sp.key] ?? "—"}</b> {sp.unit}
                        </li>
                      ))}
                    </ul>
                  )}

                  {miss && (
                    <div className="miss-box">
                      <p>漏检原因：{miss.reason}</p>
                      {miss.review ? (
                        <p className="review-note">
                          交班复核（{hm(miss.review.time)}，{miss.review.reviewer}）：
                          {miss.review.status === "confirmed" ? "确认" : "驳回"}
                          {miss.review.note ? ` — ${miss.review.note}` : ""}
                        </p>
                      ) : (
                        <p className="review-note pending">待交班复核，见下方交接摘要。</p>
                      )}
                      {miss.review?.status === "rejected" && !locked && (
                        reedit?.id === miss.id ? (
                          <div className="inline-form">
                            <input
                              value={reedit.text}
                              placeholder="补充漏检原因（必填）"
                              onChange={(e) => setReedit({ id: miss.id, text: e.target.value })}
                            />
                            <button className="primary" onClick={() => resubmitMiss(miss)}>重新提交</button>
                            <button onClick={() => setReedit(null)}>取消</button>
                          </div>
                        ) : (
                          <button className="warn" onClick={() => setReedit({ id: miss.id, text: "" })}>
                            补充原因并重新提交
                          </button>
                        )
                      )}
                    </div>
                  )}

                  {isNext && !locked && (
                    <div className="sign-box">
                      <div className="reading-grid">
                        {device.specs.map((sp) => (
                          <label key={sp.key}>
                            <span>
                              {sp.label}（{sp.min}~{sp.max} {sp.unit}）
                            </span>
                            <input
                              inputMode="decimal"
                              placeholder={`填写${sp.label}`}
                              value={drafts[sp.key] ?? ""}
                              onChange={(e) => setDrafts((prev) => ({ ...prev, [sp.key]: e.target.value }))}
                            />
                          </label>
                        ))}
                      </div>
                      <div className="sign-actions">
                        <button className="primary" onClick={signNext}>
                          签点提交
                        </button>
                        <span className={`running-flag ${data.running[device.id] === false ? "off" : ""}`}>
                          {data.running[device.id] === false ? "设备未启动，签点将被拒绝" : "设备运行中"}
                        </span>
                      </div>
                      <div className="miss-form">
                        <input
                          placeholder="无法签点时登记漏检，原因必填（如：检修停用 / 舱室封闭）"
                          value={missReason}
                          onChange={(e) => setMissReason(e.target.value)}
                        />
                        <button className="warn" onClick={registerMiss}>
                          登记漏检
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          {/* 交接摘要 */}
          <div className="handover">
            <div className="heading">
              <div>
                <p>交班复核 · 闭环控制</p>
                <h2>交接班摘要</h2>
              </div>
              <button onClick={exportSummary}>导出摘要</button>
            </div>

            {pendingMisses.length > 0 && (
              <div className="review-queue">
                <p className="queue-title">待交班复核的漏检（{pendingMisses.length}）</p>
                {current.misses.filter(isPendingMiss).map((m) => {
                  const dev = DEVICE_MAP[m.deviceId];
                  const draft = reviewDrafts[m.id] ?? { reviewer: "", note: "" };
                  return (
                    <div key={m.id} className="queue-item">
                      <div className="queue-meta">
                        <b>{dev.name}</b>
                        <span>{hm(m.time)} 登记 · 原因：{m.reason}</span>
                        {m.review?.status === "rejected" && (
                          <span className="rejected-note">上次复核驳回{m.review.note ? `：${m.review.note}` : ""}，请补充原因后再复核</span>
                        )}
                      </div>
                      <div className="queue-form">
                        <input
                          placeholder="复核人（交班轮机员 / 接班轮机员）"
                          value={draft.reviewer}
                          onChange={(e) =>
                            setReviewDrafts((prev) => ({ ...prev, [m.id]: { ...draft, reviewer: e.target.value } }))
                          }
                        />
                        <input
                          placeholder="复核意见（可选）"
                          value={draft.note}
                          onChange={(e) =>
                            setReviewDrafts((prev) => ({ ...prev, [m.id]: { ...draft, note: e.target.value } }))
                          }
                        />
                        <button className="primary" onClick={() => reviewMiss(m, "confirmed")}>
                          复核确认
                        </button>
                        <button className="warn" onClick={() => reviewMiss(m, "rejected")}>
                          驳回
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <label className="note-label">
              <span>交接备注</span>
              <textarea
                rows={3}
                placeholder="填写需向下一班移交的事项（设备工况、待处理异常、备件等）"
                value={locked ? current.handover?.note ?? "" : note}
                disabled={locked}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>

            {locked ? (
              <div className="handover-done">
                ✓ 已于 {mdhm(current.handover!.time)} 完成交接，本班路线与记录已锁定。
              </div>
            ) : (
              <div className="handover-actions">
                <button className="primary big" disabled={!canHandover} onClick={completeHandover}>
                  完成交接
                </button>
                {canHandover ? (
                  <span className="hint ok">全部设备已签点或漏检复核闭环，可以交接。</span>
                ) : (
                  <span className="hint block">交接被阻止：{blockReasons.join("；")}。</span>
                )}
              </div>
            )}
          </div>
        </section>
      </section>

      {/* 异常记录时间线 */}
      <section className="panel">
        <div className="heading">
          <div>
            <p>{dateStr} {shift.label}</p>
            <h2>异常记录时间线</h2>
          </div>
          <span className="hint">签点 / 拒绝 / 漏检 / 复核 / 交接全程留痕</span>
        </div>
        {visibleEvents.length === 0 ? (
          <p className="empty">本班次暂无记录{filter !== "全部" ? `（当前筛选：${filter}）` : ""}。</p>
        ) : (
          <ul className="timeline">
            {visibleEvents.map((e) => (
              <li key={e.id} className={`tl-${e.kind}`}>
                <time>{hm(e.time)}</time>
                <span className={`tag ${eventTag[e.kind].cls}`}>{eventTag[e.kind].text}</span>
                {e.deviceId && <span className="tl-device">{DEVICE_MAP[e.deviceId]?.name}</span>}
                <span className="tl-text">{e.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 按设备筛选的历史记录 */}
      <section className="panel">
        <div className="heading">
          <div>
            <p>本地数据 · 刷新保留</p>
            <h2>历史记录{filter !== "全部" ? `（${filter}）` : ""}</h2>
          </div>
        </div>
        {history.length === 0 ? (
          <p className="empty">暂无历史记录{filter !== "全部" ? `（当前筛选：${filter}）` : ""}。</p>
        ) : (
          <div className="records">
            {history.map((item, i) => (
              <article key={`${item.time}-${i}`}>
                <b>{String(i + 1).padStart(2, "0")}</b>
                <div>
                  <h3>
                    {item.shiftLabel}
                    <span className={`tag ${eventTag[item.kind].cls}`}>{eventTag[item.kind].text}</span>
                    {item.deviceId && <small className="cat-tag">{DEVICE_MAP[item.deviceId]?.name}</small>}
                  </h3>
                  <p>{item.lines.join(" · ")}</p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

export default App;
