import { RefreshCw } from "lucide-react";
import { useQuery, Button, ErrorNote, Loading, bytes, date } from "./ui";

export function SystemStatus() {
  const query = useQuery("system_status");
  if (query.loading && !query.data) return <Loading />;
  const data = query.data;
  const names = { works: "作品工作区", repos: "Git 仓库", libraries: "素材分支", blobs: "素材原件", runs: "任务副本与导出", sessions: "AI 会话", tools: "CLI 工具" };
  return (
    <section>
      <div className="section-head">
        <h2>运行状态</h2>
        <Button icon={RefreshCw} disabled={query.loading} onClick={query.refresh}>刷新</Button>
      </div>
      <ErrorNote error={query.error} />
      {data && <>
        <p>{data.ready ? "执行基础设施就绪" : "执行基础设施需要检查"} · 检查时间 {date(data.checked)}（结果缓存 30 秒）</p>
        <div className="panel">
          <p>Docker：{data.docker.ok ? data.docker.version || "正常" : "不可用"} · 语音服务：{data.speech.ok ? "正常" : "不可用"}</p>
          <p>排队 {data.queue.queued} · 执行中 {data.queue.running} / {data.limits.concurrency} · 正在保存 {data.queue.publishing} · 待恢复 {data.queue.needs_recovery}</p>
          <p>最早任务等待 {Math.floor(data.queue.oldest_wait_seconds / 60)} 分钟</p>
          <ErrorNote error={data.queueBlocked} />
          {data.queue.needs_recovery > 0 && <p role="status">有执行结果尚未保存完成，请打开对应作品的后台任务，处理错误后点击「重试保存结果」。</p>}
        </div>
        <h3>存储</h3>
        <p>{data.disk.ok ? `可用 ${bytes(data.disk.freeBytes)} / 总容量 ${bytes(data.disk.totalBytes)}` : "无法读取磁盘容量"} · 新任务安全阈值 {bytes(data.limits.minFreeBytes)}</p>
        {Object.entries(data.sizes).map(([name, size]) => <div className="settings-row" key={name}>
          <span>{names[name] || name}</span><span>{size.partial ? "至少 " : ""}{bytes(size.bytes)}{size.partial ? "（限时扫描未完成）" : ""}</span>
        </div>)}
        <small>分类统计是文件逻辑大小，不等于去重后的实际磁盘占用；有上限扫描不会为了统计而遍历全部大目录。</small>
        <h3>数据库版本</h3>
        {data.schema.map((item) => <div className="settings-row" key={item.id}><code>{item.id}</code><span>{date(item.applied)}</span></div>)}
      </>}
    </section>
  );
}
