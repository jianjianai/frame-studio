import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useAllEnvironmentShellsBootstrapped, useProjects, useThreadShellsForProjectRefs } from "../state/entities";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { SidebarProvider } from "../components/ui/sidebar";
import { frameBootstrap } from "./frameHost";

/** Keep the native timeline/composer; the host dock only lists this physical project. */
export function FrameEmbeddedLayout({ children }: { children: ReactNode }) {
  const config = frameBootstrap!;
  const project = useProjects().find(value => value.id === config.projectId && value.environmentId === config.environmentId);
  const refs = useMemo(() => project ? [scopeProjectRef(project.environmentId, project.id)] : [], [project?.id, project?.environmentId]);
  const threads = useThreadShellsForProjectRefs(refs);
  const newThread = useNewThreadHandler();
  const pathname = useLocation({ select: value => value.pathname });
  const navigate = useNavigate();
  return <SidebarProvider defaultOpen={false} className="h-dvh! min-h-0! flex-col!">
    <div className="flex shrink-0 items-center gap-2 border-b px-2 py-2" aria-label="Current project chats">
      <select aria-label="Chat" className="min-w-0 flex-1 rounded bg-background px-2 py-1 text-sm"
        value={threads.find(thread => pathname.endsWith('/' + thread.id))?.id ?? ''}
        onChange={event => { const thread = threads.find(value => value.id === event.target.value); if (thread) void navigate({ to: "/$environmentId/$threadId", params: { environmentId: thread.environmentId, threadId: thread.id } }); }}>
        <option value="" disabled>{config.label}</option>
        {threads.filter(thread => thread.archivedAt === null).map(thread => <option key={thread.id} value={thread.id}>{thread.title || 'New chat'}</option>)}
      </select>
      <button type="button" disabled={!project} className="rounded border px-2 py-1 text-sm" onClick={() => project && void newThread(refs[0]!, { envMode: "local" })}>New chat</button>
      <Link to="/" className="sr-only">Current project</Link>
    </div>
    <div className="flex min-h-0 flex-1">{children}</div>
  </SidebarProvider>;
}

/** Reopen the last active chat in this work, creating a native draft only when needed. */
export function FrameEmbeddedLanding() {
  const config = frameBootstrap!;
  const project = useProjects().find(value => value.id === config.projectId && value.environmentId === config.environmentId);
  const refs = useMemo(() => project ? [scopeProjectRef(project.environmentId, project.id)] : [], [project?.id, project?.environmentId]);
  const threads = useThreadShellsForProjectRefs(refs);
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const navigate = useNavigate();
  const newThread = useNewThreadHandler();
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!bootstrapped || !project || started.current) return;
    started.current = true;
    const latest = threads.reduce<(typeof threads)[number] | null>((current, thread) => thread.archivedAt !== null ? current : !current || thread.updatedAt > current.updatedAt ? thread : current, null);
    const operation = latest ? navigate({ to: "/$environmentId/$threadId", params: { environmentId: latest.environmentId, threadId: latest.id }, replace: true }) : newThread(refs[0]!, { envMode: "local", replace: true });
    void operation.catch(cause => { started.current = false; setError(cause instanceof Error ? cause.message : "Could not open this project's chat"); });
  }, [bootstrapped, project, threads, navigate, newThread, refs]);
  return error ? <div role="alert" className="p-4 text-sm">{error}</div> : null;
}
