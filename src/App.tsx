import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import {
  ROUTE,
  WATCHES,
  STORAGE_KEY,
  emptyShift,
  shiftKey,
  deviceName,
  fmtTime,
  summarizeReadings,
  uid,
  validateSignoff,
  MISS_STATUS_LABEL,
  EVENT_META,
  loadState,
  type RootState,
  type ShiftState,
  type DeviceId,
  type DeviceDef,
  type TimelineEvent,
} from "./inspection";

const PROJECT = {
  id: "hxyfront-62001",
  sourceNo: 1,
  port: 62001,
  title: "船舶轮机值班记录",
};

const EMPTY_SHIFT: ShiftState = emptyShift();

const MAIN_METRICS = [
  { label: "主机转速", key: "rpm", unit: "rpm" },
  { label: "滑油压力", key: "oil", unit: "MPa" },
  { label: "冷却水温", key: "cool", unit: "℃" },
  { label: "燃油消耗", key: "fuel", unit: "L" },
];

type Filter = "all" | DeviceId;
type Notice = { tone: "danger" | "ok"; text: string } | null;

function blankForm(device: DeviceDef | null): Record<string, string> {
  const form: Record<string, string> = {};
  device?.fields.forEach((f) => {
    form[f.key] = "";
  });
  return form;
}

function App() {
  const [state, setState] = useState<RootState>(loadState);
  const [deviceFilter, setDeviceFilter] = useState<Filter>("all");
  const [notice, setNotice] = useState<Notice>(null);
  const [missReason, setMissReason] = useState("");
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, string>>({});

  // 本地数据同步：任何状态变更都写入 localStorage，刷新后保留
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // 存储不可用时仅保留内存态，不引入任何外部服务兜底
    }
  }, [state]);

  const key = shiftKey(state.date, state.watch);
  const shift = state.shifts[key] ?? EMPTY_SHIFT;

  const missByDevice = useMemo(() => {
    const map = {} as Partial<Record<DeviceId, ShiftState["misses"][number]>>;
    shift.misses.forEach((m) => {
      map[m.deviceId] = m;
    });
    return map;
  }, [shift]);

  // 路线上第一台既未签点也未登记漏检（含待复核/驳回）的设备
  const activeDevice =
    ROUTE.find((d) => !shift.signoffs[d.id] && !missByDevice[d.id]) ?? null;

  const [form, setForm] = useState<Record<string, string>>(() =>
    blankForm(activeDevice)
  );
  const [running, setRunning] = useState(false);

  // 切换班次时清空提示
  useEffect(() => {
    setNotice(null);
  }, [key]);

  // 当前签点设备推进（或换班）时复位表单
  useEffect(() => {
    setForm(blankForm(activeDevice));
    setRunning(false);
    setMissReason("");
  }, [key, activeDevice?.id]);

  const updateShift = (
    updater: (s: ShiftState) => ShiftState,
    patch?: Partial<RootState>
  ) => {
    setState((prev) => {
      const k = shiftKey(prev.date, prev.watch);
      const base = prev.shifts[k] ?? emptyShift();
      return {
        ...prev,
        ...patch,
        shifts: { ...prev.shifts, [k]: updater(base) },
      };
    });
  };

  const pushEvent = (
    s: ShiftState,
    ev: Omit<TimelineEvent, "id" | "time">
  ): ShiftState => ({
    ...s,
    events: [...s.events, { ...ev, id: uid(), time: new Date().toISOString() }],
  });

  const requireName = (name: string, label: string): boolean => {
    if (!name.trim()) {
      setNotice({ tone: "danger", text: `请先填写${label}姓名` });
      return false;
    }
    return true;
  };

  // —— 顺序签点：读数越界或设备未启动则整次拒绝，路线与看板保持不变 ——
  const submitSignoff = (device: DeviceDef) => {
    if (shift.handedOver || activeDevice?.id !== device.id) return;
    if (!requireName(state.operator, "值班轮机员")) return;

    const error = validateSignoff(device, form, running);
    if (error) {
      updateShift((s) =>
        pushEvent(s, {
          deviceId: device.id,
          kind: "reject",
          detail: error,
          operator: state.operator.trim(),
        })
      );
      setNotice({ tone: "danger", text: error });
      return;
    }

    const readings: Record<string, number> = {};
    device.fields.forEach((f) => {
      readings[f.key] = Number(form[f.key]);
    });
    const time = new Date().toISOString();
    updateShift((s) => ({
      ...s,
      signoffs: {
        ...s.signoffs,
        [device.id]: {
          deviceId: device.id,
          readings,
          running,
          operator: state.operator.trim(),
          time,
        },
      },
    }));
    setNotice({ tone: "ok", text: `${device.name}签点成功，路线已推进` });
  };

  // —— 漏检登记：必须写明原因，进入交班复核 ——
  const registerMiss = (device: DeviceDef) => {
    if (shift.handedOver || activeDevice?.id !== device.id) return;
    if (!requireName(state.operator, "值班轮机员")) return;
    const reason = missReason.trim();
    if (!reason) {
      setNotice({ tone: "danger", text: "漏检设备必须写明原因" });
      return;
    }
    const time = new Date().toISOString();
    updateShift((s) => ({
      ...pushEvent(s, {
        deviceId: device.id,
        kind: "miss",
        detail: `漏检登记：${reason}`,
        operator: state.operator.trim(),
      }),
      misses: [
        ...s.misses,
        {
          id: uid(),
          deviceId: device.id,
          reason,
          operator: state.operator.trim(),
          time,
          status: "pending",
        },
      ],
    }));
    setMissReason("");
    setNotice({ tone: "ok", text: `${device.name}已登记漏检，等待交班复核` });
  };

  const reviewMiss = (
    missId: string,
    approve: boolean,
    reviewer: string
  ) => {
    const miss = shift.misses.find((m) => m.id === missId);
    if (!miss || shift.handedOver) return;
    const time = new Date().toISOString();
    updateShift((s) => ({
      ...pushEvent(s, {
        deviceId: miss.deviceId,
        kind: approve ? "review-approve" : "review-reject",
        detail: approve
          ? `漏检原因复核通过：${miss.reason}`
          : `漏检原因复核驳回：${miss.reason}`,
        operator: reviewer,
      }),
      misses: s.misses.map((m) =>
        m.id === missId
          ? { ...m, status: approve ? "approved" : "rejected", reviewer, reviewedAt: time }
          : m
      ),
    }));
  };

  // 驳回后的漏检由轮机员补充原因并重新提交，仍需再次复核
  const resubmitMiss = (missId: string) => {
    const miss = shift.misses.find((m) => m.id === missId);
    if (!miss || shift.handedOver) return;
    if (!requireName(state.operator, "值班轮机员")) return;
    const reason = (reviewDrafts[missId] ?? "").trim();
    if (!reason) {
      setNotice({ tone: "danger", text: "重新提交时漏检原因不能为空" });
      return;
    }
    updateShift((s) => ({
      ...pushEvent(s, {
        deviceId: miss.deviceId,
        kind: "miss-resubmit",
        detail: `漏检原因修改后重新提交：${reason}`,
        operator: state.operator.trim(),
      }),
      misses: s.misses.map((m) =>
        m.id === missId
          ? { ...m, reason, status: "pending", reviewer: undefined, reviewedAt: undefined }
          : m
      ),
    }));
    setNotice({ tone: "ok", text: `${deviceName(miss.deviceId)}漏检原因已重新提交` });
  };

  const unresolvedMisses = shift.misses.filter((m) => m.status !== "approved");
  const routeDone = !activeDevice;

  const handoverBlockers: string[] = [];
  if (!routeDone) {
    handoverBlockers.push(
      `巡检路线未走完：${activeDevice ? activeDevice.name : ""}尚未签点或登记漏检`
    );
  }
  if (unresolvedMisses.length > 0) {
    const names = unresolvedMisses
      .map((m) => `${deviceName(m.deviceId)}（${MISS_STATUS_LABEL[m.status]}）`)
      .join("、");
    handoverBlockers.push(`仍有待复核漏检：${names}`);
  }
  if (!state.operator.trim()) handoverBlockers.push("未填写值班轮机员");
  if (!state.reviewer.trim()) handoverBlockers.push("未填写交班复核人");
  const canHandOver = handoverBlockers.length === 0 && !shift.handedOver;

  const completeHandover = () => {
    if (!canHandOver) return;
    const time = new Date().toISOString();
    const reviewer = state.reviewer.trim();
    updateShift((s) => ({
      ...pushEvent(s, {
        deviceId: "system",
        kind: "handover",
        detail: s.handoverNote.trim()
          ? `交接备注：${s.handoverNote.trim()}`
          : "交接备注：无",
        operator: reviewer,
      }),
      handedOver: true,
      handedOverAt: time,
      handoverOperator: state.operator.trim(),
      handoverReviewer: reviewer,
    }));
    setNotice({ tone: "ok", text: "本班次交接已完成，路线已锁定" });
  };

  const switchShift = (patch: { date?: string; watch?: string }) => {
    const date = patch.date ?? state.date;
    const watch = patch.watch ?? state.watch;
    const k = shiftKey(date, watch);
    setState((prev) => ({
      ...prev,
      date,
      watch,
      shifts: prev.shifts[k] ? prev.shifts : { ...prev.shifts, [k]: emptyShift() },
    }));
  };

  const exportSummary = () => {
    const lines: string[] = [];
    lines.push("船舶轮机值班交接班摘要");
    lines.push(`班次：${state.date} ${state.watch}`);
    lines.push(`状态：${shift.handedOver ? "已完成交接" : "未交接"}`);
    lines.push(
      `签点进度：${Object.keys(shift.signoffs).length}/${ROUTE.length}；漏检 ${shift.misses.length} 项（待复核 ${unresolvedMisses.length}）`
    );
    lines.push("");
    lines.push("巡检路线：");
    ROUTE.forEach((d, i) => {
      const sign = shift.signoffs[d.id];
      const miss = missByDevice[d.id];
      let tail: string;
      if (sign) {
        tail = `已签点 ${fmtTime(sign.time)}，${summarizeReadings(d, sign.readings)}，运行状态：${
          sign.running ? "运行" : "停止"
        }，签点人：${sign.operator}`;
      } else if (miss) {
        tail = `漏检（${MISS_STATUS_LABEL[miss.status]}），原因：${miss.reason}，登记人：${
          miss.operator
        }${miss.reviewer ? `，复核人：${miss.reviewer}` : ""}`;
      } else {
        tail = "未处理";
      }
      lines.push(`${i + 1}. ${d.name}：${tail}`);
    });
    lines.push("");
    lines.push("异常时间线：");
    if (shift.events.length === 0) {
      lines.push("无");
    } else {
      shift.events.forEach((e) => {
        lines.push(
          `- [${fmtTime(e.time)}] ${deviceName(e.deviceId)} · ${EVENT_META[e.kind].label}：${
            e.detail
          }（${e.operator}）`
        );
      });
    }
    lines.push("");
    lines.push(`交接备注：${shift.handoverNote.trim() || "无"}`);
    if (shift.handedOver) {
      lines.push(
        `交接人：${shift.handoverOperator ?? ""}；复核人：${
          shift.handoverReviewer ?? ""
        }；交接时间：${shift.handedOverAt ? fmtTime(shift.handedOverAt) : ""}`
      );
    }
    const blob = new Blob([lines.join("\n")], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `交接班摘要_${state.date}_${state.watch}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const resetAll = () => {
    if (!window.confirm("确定清空本机全部值班数据？该操作不可恢复。")) return;
    const fresh = ((): RootState => {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const watch = WATCHES[Math.min(WATCHES.length - 1, Math.floor(d.getHours() / 4))];
      return {
        version: 1,
        date,
        watch,
        operator: state.operator,
        reviewer: state.reviewer,
        shifts: { [shiftKey(date, watch)]: emptyShift() },
      };
    })();
    setState(fresh);
    setDeviceFilter("all");
  };

  const mainSign = shift.signoffs.main;
  const filteredEvents = shift.events.filter(
    (e) => deviceFilter === "all" || e.deviceId === deviceFilter
  );
  const historySignoffs = ROUTE.filter(
    (d) => shift.signoffs[d.id] && (deviceFilter === "all" || d.id === deviceFilter)
  )
    .map((d) => ({ device: d, sign: shift.signoffs[d.id]! }))
    .sort((a, b) => (a.sign.time < b.sign.time ? 1 : -1));

  return (
    <main className="app">
      <header className="topbar panel">
        <div>
          <p className="kicker">
            {PROJECT.id} · 源提示词{PROJECT.sourceNo} · Port {PROJECT.port}
          </p>
          <h1>{PROJECT.title} · 巡检签点闭环</h1>
        </div>
        <div className="topbar-right">
          <span className={`badge ${shift.handedOver ? "badge-ok" : "badge-info"}`}>
            {shift.handedOver ? "本班已交接" : "值班进行中"}
          </span>
          <button className="ghost" onClick={resetAll}>
            清空本机数据
          </button>
        </div>
      </header>

      <section className="watchbar panel">
        <label>
          <span>值班日期</span>
          <input
            type="date"
            value={state.date}
            disabled={shift.handedOver}
            onChange={(e) => switchShift({ date: e.target.value })}
          />
        </label>
        <label>
          <span>值班班次</span>
          <select
            value={state.watch}
            disabled={shift.handedOver}
            onChange={(e) => switchShift({ watch: e.target.value })}
          >
            {WATCHES.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          <span>值班轮机员</span>
          <input
            placeholder="签点与漏检登记人"
            value={state.operator}
            disabled={shift.handedOver}
            onChange={(e) => setState({ ...state, operator: e.target.value })}
          />
        </label>
        <label className="grow">
          <span>交班复核人</span>
          <input
            placeholder="漏检复核与交接确认人"
            value={state.reviewer}
            onChange={(e) => setState({ ...state, reviewer: e.target.value })}
          />
        </label>
      </section>

      <section className="metrics">
        {MAIN_METRICS.map((m) => (
          <article key={m.key}>
            <small>{m.label}</small>
            <strong>
              {mainSign ? mainSign.readings[m.key] : "—"}
              <em>{mainSign ? m.unit : "待主机签点"}</em>
            </strong>
          </article>
        ))}
      </section>

      <div className="workspace">
        {/* 固定巡检序列：主机 → 发电机 → 泵组 → 舱底水 */}
        <section className="panel route-panel">
          <div className="heading">
            <div>
              <p>固定巡检路线</p>
              <h2>顺序签点</h2>
            </div>
            <span className="muted">
              {Object.keys(shift.signoffs).length}/{ROUTE.length} 已签点 ·{" "}
              {shift.misses.length} 项漏检
            </span>
          </div>

          {shift.handedOver && (
            <div className="notice info">
              本班次已于{shift.handedOverAt ? fmtTime(shift.handedOverAt) : ""}完成交接，路线与看板已锁定。
            </div>
          )}
          {notice && (
            <div className={`notice ${notice.tone === "danger" ? "danger" : "ok"}`}>
              {notice.text}
            </div>
          )}

          <ol className="steps">
            {ROUTE.map((device, index) => {
              const sign = shift.signoffs[device.id];
              const miss = missByDevice[device.id];
              const isActive = !shift.handedOver && activeDevice?.id === device.id;
              const locked =
                !shift.handedOver && !sign && !miss && activeDevice?.id !== device.id;

              let cls = "step";
              if (sign) cls += " step--done";
              else if (miss) cls += miss.status === "approved" ? " step--skipped" : " step--waiting";
              else if (isActive) cls += " step--active";
              else if (locked) cls += " step--locked";

              return (
                <li key={device.id} className={cls}>
                  <div className="step-head">
                    <b>{index + 1}</b>
                    <h3>{device.name}</h3>
                    {sign && <span className="tag tag-ok">已签点</span>}
                    {miss && (
                      <span
                        className={`tag ${
                          miss.status === "approved"
                            ? "tag-skip"
                            : miss.status === "rejected"
                            ? "tag-danger"
                            : "tag-warn"
                        }`}
                      >
                        漏检 · {MISS_STATUS_LABEL[miss.status]}
                      </span>
                    )}
                    {isActive && <span className="tag tag-info">当前签点</span>}
                    {locked && <span className="tag tag-muted">未到顺序</span>}
                  </div>

                  {sign && (
                    <div className="step-body">
                      <p>{summarizeReadings(device, sign.readings)}</p>
                      <p className="muted small">
                        {device.requiresRunning
                          ? `设备状态：${sign.running ? "运行中" : "停止"} · `
                          : ""}
                        {fmtTime(sign.time)} · {sign.operator}
                      </p>
                    </div>
                  )}

                  {miss && !sign && (
                    <div className="step-body">
                      <p>漏检原因：{miss.reason}</p>
                      <p className="muted small">
                        登记：{fmtTime(miss.time)} · {miss.operator}
                        {miss.reviewer ? ` · 复核：${miss.reviewer}` : ""}
                      </p>
                      {miss.status === "pending" && (
                        <p className="muted small">等待交班复核，后续设备暂不可签点。</p>
                      )}
                      {miss.status === "rejected" && (
                        <p className="muted small">复核被驳回，请在右侧待复核面板补充原因后重新提交。</p>
                      )}
                    </div>
                  )}

                  {isActive && (
                    <div className="step-body">
                      <div className="reading-grid">
                        {device.fields.map((f) => (
                          <label key={f.key}>
                            <span>
                              {f.label}（{f.min}~{f.max}
                              {f.unit}）
                            </span>
                            <input
                              inputMode="decimal"
                              placeholder={`允许 ${f.min}~${f.max}${f.unit}`}
                              value={form[f.key] ?? ""}
                              onChange={(e) =>
                                setForm({ ...form, [f.key]: e.target.value })
                              }
                            />
                          </label>
                        ))}
                      </div>
                      {device.requiresRunning && (
                        <label className="check-row">
                          <input
                            type="checkbox"
                            checked={running}
                            onChange={(e) => setRunning(e.target.checked)}
                          />
                          <span>设备已启动并处于运行状态（未启动签点将被整次拒绝）</span>
                        </label>
                      )}
                      <div className="step-actions">
                        <button className="primary" onClick={() => submitSignoff(device)}>
                          确认签点
                        </button>
                      </div>
                      <div className="miss-box">
                        <label className="grow">
                          <span>无法签点时登记漏检（须写明原因，进入交班复核）</span>
                          <input
                            placeholder="例如：设备检修停用 / 机舱进水风险处置中"
                            value={missReason}
                            onChange={(e) => setMissReason(e.target.value)}
                          />
                        </label>
                        <button onClick={() => registerMiss(device)}>登记漏检</button>
                      </div>
                    </div>
                  )}

                  {locked && <p className="muted small step-lock">🔒 前序设备未闭环，不能提前签点</p>}
                </li>
              );
            })}
          </ol>
        </section>

        <div className="side-col">
          {/* 待复核漏检：未清空之前不得完成交接 */}
          <section className="panel">
            <div className="heading">
              <div>
                <p>交班复核</p>
                <h2>待复核漏检</h2>
              </div>
              <span className={`badge ${unresolvedMisses.length ? "badge-warn" : "badge-ok"}`}>
                {unresolvedMisses.length} 项未闭环
              </span>
            </div>
            {shift.misses.length === 0 && <p className="muted">本班暂无漏检登记。</p>}
            <div className="review-list">
              {shift.misses.map((m) => (
                <article key={m.id} className="review-card">
                  <div className="step-head">
                    <h3>{deviceName(m.deviceId)}</h3>
                    <span
                      className={`tag ${
                        m.status === "approved"
                          ? "tag-skip"
                          : m.status === "rejected"
                          ? "tag-danger"
                          : "tag-warn"
                      }`}
                    >
                      {MISS_STATUS_LABEL[m.status]}
                    </span>
                  </div>
                  {m.status === "rejected" ? (
                    <label className="stack">
                      <span>补充漏检原因后重新提交</span>
                      <textarea
                        rows={2}
                        value={reviewDrafts[m.id] ?? m.reason}
                        onChange={(e) =>
                          setReviewDrafts({ ...reviewDrafts, [m.id]: e.target.value })
                        }
                      />
                    </label>
                  ) : (
                    <p>原因：{m.reason}</p>
                  )}
                  <p className="muted small">
                    登记人 {m.operator} · {fmtTime(m.time)}
                    {m.reviewer ? ` · 复核人 ${m.reviewer}` : ""}
                  </p>
                  {!shift.handedOver && m.status !== "approved" && (
                    <div className="step-actions">
                      {m.status === "rejected" && (
                        <button onClick={() => resubmitMiss(m.id)}>重新提交</button>
                      )}
                      <button
                        className="primary"
                        onClick={() => {
                          if (!requireName(state.reviewer, "交班复核人")) return;
                          reviewMiss(m.id, true, state.reviewer.trim());
                        }}
                      >
                        复核通过
                      </button>
                      {m.status === "pending" && (
                        <button
                          className="danger-btn"
                          onClick={() => {
                            if (!requireName(state.reviewer, "交班复核人")) return;
                            reviewMiss(m.id, false, state.reviewer.trim());
                          }}
                        >
                          驳回
                        </button>
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>

          {/* 交接班摘要 */}
          <section className="panel">
            <div className="heading">
              <div>
                <p>闭环出口</p>
                <h2>交接班摘要</h2>
              </div>
              <button className="ghost" onClick={exportSummary}>
                导出摘要
              </button>
            </div>
            <ul className="summary-list">
              <li>
                签点进度：
                <b>
                  {Object.keys(shift.signoffs).length}/{ROUTE.length}
                </b>
              </li>
              <li>
                漏检：<b>{shift.misses.length}</b> 项，其中待复核/驳回{" "}
                <b className={unresolvedMisses.length ? "text-danger" : ""}>
                  {unresolvedMisses.length}
                </b>{" "}
                项
              </li>
              <li>
                路线状态：
                <b>{routeDone ? "全部设备已闭环" : `停留于 ${activeDevice?.name}`}</b>
              </li>
            </ul>
            <label className="stack">
              <span>交接备注</span>
              <textarea
                rows={3}
                placeholder="舱底水液位、设备异常及下一班注意事项"
                value={shift.handoverNote}
                disabled={shift.handedOver}
                onChange={(e) =>
                  updateShift((s) => ({ ...s, handoverNote: e.target.value }))
                }
              />
            </label>
            {!shift.handedOver && handoverBlockers.length > 0 && (
              <div className="notice danger">
                <b>暂不能完成交接：</b>
                <ul>
                  {handoverBlockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            )}
            {shift.handedOver && (
              <div className="notice ok">
                交接完成：{shift.handoverOperator} → {shift.handoverReviewer}，时间{" "}
                {shift.handedOverAt ? fmtTime(shift.handedOverAt) : ""}
              </div>
            )}
            {!shift.handedOver && (
              <button className="primary block" disabled={!canHandOver} onClick={completeHandover}>
                {canHandOver ? "完成交接并锁定本班" : "仍有未闭环事项，禁止交接"}
              </button>
            )}
          </section>
        </div>
      </div>

      {/* 设备筛选：同时作用于异常时间线与历史记录 */}
      <section className="panel filter-bar">
        <h2>设备筛选</h2>
        <div className="chips">
          <button
            className={deviceFilter === "all" ? "active" : ""}
            onClick={() => setDeviceFilter("all")}
          >
            全部
          </button>
          {ROUTE.map((d) => (
            <button
              key={d.id}
              className={deviceFilter === d.id ? "active" : ""}
              onClick={() => setDeviceFilter(d.id)}
            >
              {d.shortName}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>异常记录时间线</p>
            <h2>本班异常时间线</h2>
          </div>
          <span className="muted">签点拒绝与漏检复核全程留痕</span>
        </div>
        {filteredEvents.length === 0 ? (
          <p className="muted">
            当前筛选下暂无异常记录{deviceFilter === "all" ? "，签点被拒绝或漏检复核时将自动登记" : ""}。
          </p>
        ) : (
          <ul className="timeline">
            {filteredEvents
              .slice()
              .reverse()
              .map((e) => (
                <li key={e.id} className={`tone-${EVENT_META[e.kind].tone}`}>
                  <time>{fmtTime(e.time)}</time>
                  <span className="tag tag-info">{deviceName(e.deviceId)}</span>
                  <span className={`tag tag-tone-${EVENT_META[e.kind].tone}`}>
                    {EVENT_META[e.kind].label}
                  </span>
                  <p>{e.detail}</p>
                  <small className="muted">{e.operator}</small>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>历史记录</p>
            <h2>
              {state.date} {state.watch} 签点记录
            </h2>
          </div>
        </div>
        {historySignoffs.length === 0 ? (
          <p className="muted">当前筛选下暂无签点记录。</p>
        ) : (
          <div className="records">
            {historySignoffs.map(({ device, sign }, index) => (
              <article key={device.id}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <div>
                  <h3>
                    {device.name}
                    <span className="tag tag-ok tag-inline">已签点</span>
                  </h3>
                  <p>{summarizeReadings(device, sign.readings)}</p>
                  <p className="muted small">
                    {fmtTime(sign.time)} · {sign.operator} ·{" "}
                    {device.requiresRunning ? (sign.running ? "运行中" : "停止") : "状态量不适用"}
                  </p>
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
