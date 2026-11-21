import FocusPanel from "./FocusPanel";
import HabitsView from "./HabitsView";
import TasksPanel from "./TasksPanel";

const tabs = [
  ["tasks", "任务"],
  ["focus", "番茄钟"],
  ["habits", "习惯"],
] as const;

export type PlanSection = (typeof tabs)[number][0];

const lead: Record<PlanSection, string> = {
  tasks: "今天只看今天的。做不完就改到明天。",
  focus: "做完一轮就休息。中途停下也不会少掉什么。",
  habits: "重复的小事放在这里。今天还没打卡，连续天数会留到今天结束。",
};

export default function PlanView({ section, select }: {
  section: PlanSection;
  select: (section: PlanSection) => void;
}) {
  const title = section === "focus" ? "番茄专注" : (tabs.find(([id]) => id === section)?.[1] ?? "安排");
  return <div className={section === "focus" ? "l-page l-page-focus" : "l-page"}>
    <header className="l-head">
      <div>
        <h1>{title}</h1>
        {section !== "focus" && <p>{lead[section]}</p>}
      </div>
      <div className="l-controls" aria-label="安排">
        {tabs.map(([id, label]) => (
          <button key={id} aria-pressed={section === id} onClick={() => select(id)}>{label}</button>
        ))}
      </div>
    </header>
    {section === "tasks" && <TasksPanel />}
    {section === "focus" && <FocusPanel />}
    {section === "habits" && <HabitsView />}
  </div>;
}
