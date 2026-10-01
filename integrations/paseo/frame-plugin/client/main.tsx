import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type {
  PluginClientContext,
  PluginButtonRegistration,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import {
  FrameBootstrapSchema,
  FrameReviewContextSchema,
  type FrameReviewContext,
  type FrameOperation,
} from "../shared/bridge";
import { getFrameClientBridge } from "./bridge";

let failure: string | null = null;
const listeners = new Set<() => void>();
function setFailure(error: unknown): void {
  failure = error instanceof Error ? error.message : String(error);
  for (const listener of listeners) listener();
}
function subscribeFailure(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
async function request(op: FrameOperation, payload: unknown): Promise<unknown> {
  const bridge = getFrameClientBridge();
  if (!bridge) throw new Error("作品连接尚未就绪，请重新连接。");
  return bridge.request(op, payload);
}

export function contributeFrameClient(client: PluginClientContext): () => void {
  const config = FrameBootstrapSchema.safeParse(Reflect.get(globalThis, "__PASEO_FRAME_EMBED__"));
  if (!config.success) return () => {};
  const controls = new Map<string, PluginButtonRegistration[]>();
  const lifetime = new AbortController();
  let stopped = false;
  function remove(id: string): void {
    controls.get(id)?.forEach((control) => control.remove());
    controls.delete(id);
  }
  function register(agent: { id: string; workspaceId?: string | null }): void {
    remove(agent.id);
    if (stopped || !config.success || !agent.workspaceId) return;
    const workspaceId = agent.workspaceId;
    const attach = client.addComposerPill({
      id: "context",
      workspaceId,
      agentId: agent.id,
      button: {
        title: "引用当前画面与所选素材",
        label: "引用作品",
        icon: "Film",
        behavior: {
          kind: "action",
          onPress() {
            void request("context.attach", { agentId: agent.id }).catch((error) => {
              setFailure(error);
              client.openPanel("work", { workspaceId });
            });
          },
        },
      },
    });
    const open = client.addComposerPill({
      id: "work",
      workspaceId,
      agentId: agent.id,
      button: {
        title: "打开 Frame 作品预览、结果与历史",
        label: "作品工具",
        icon: "PanelsTopLeft",
        behavior: {
          kind: "action",
          onPress() {
            client.openPanel("work", { workspaceId });
          },
        },
      },
    });
    controls.set(agent.id, [attach, open]);
  }
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      if (stopped) return undefined;
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const id of controls.keys()) remove(id);
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") remove(update.agentId);
          else register(update.agent);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!stopped) setFailure(error);
    });
  return () => {
    stopped = true;
    lifetime.abort();
    for (const id of controls.keys()) remove(id);
  };
}

export function FramePanel({ theme, layout }: PluginWorkspacePanelProps) {
  const [context, setContext] = useState<FrameReviewContext | null>(null);
  const [pending, setPending] = useState(false);
  const error = useSyncExternalStore(subscribeFailure, () => failure);
  useEffect(() => {
    const bridge = getFrameClientBridge();
    let active = true;
    setPending(true);
    void request("context.read", {})
      .then((value) => {
        if (!active) return undefined;
        setContext(FrameReviewContextSchema.parse(value));
        return undefined;
      })
      .catch((reason) => {
        if (active) setFailure(reason);
      })
      .finally(() => {
        if (active) setPending(false);
      });
    const unsubscribe = bridge?.subscribe((event, payload) => {
      if (event !== "context.changed") return;
      const result = FrameReviewContextSchema.safeParse(payload);
      if (result.success) setContext(result.data);
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 16 : 24, gap: 16 },
      title: { color: theme.colors.foreground, fontSize: 22 },
      muted: { color: theme.colors.foregroundMuted },
      detail: { color: theme.colors.foreground },
      info: { gap: 8 },
      button: {
        padding: 14,
        minHeight: 44,
        borderRadius: 10,
        backgroundColor: theme.colors.accent,
      },
      buttonText: { color: theme.colors.accentForeground },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );
  const run = useCallback((op: FrameOperation) => {
    setPending(true);
    void request(op, {})
      .catch(setFailure)
      .finally(() => setPending(false));
  }, []);
  const actions = useMemo(
    () =>
      (
        [
          ["preview.open", "查看作品预览"],
          ["results.open", "查看结果与原有历史"],
          ["dock.close", "返回作品"],
        ] as const
      ).map(([op, title]) => ({ op, title, onPress: () => run(op) })),
    [run],
  );
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Frame 作品</Text>
      <Text style={styles.muted}>
        模型、权限请求、提问和对话由 Paseo 管理。作品预览、校验、应用和原有历史在 Frame 中继续保留。
      </Text>
      <View style={styles.info}>
        <Text style={styles.detail}>当前画面：{context?.time?.toFixed(2) ?? "未定位"} 秒</Text>
        <Text style={styles.detail}>所选素材：{context?.assets?.length ?? 0} 个</Text>
        <Text style={styles.muted}>
          {context?.sourceRevision || context?.sourceCommit
            ? "发送时将固定当前来源版本。"
            : "当前没有版本化预览，发送时会明确标记。"}
        </Text>
      </View>
      {actions.map(({ op, title, onPress }) => (
        <Pressable
          key={op}
          accessibilityRole="button"
          accessibilityLabel={title}
          disabled={pending}
          onPress={onPress}
          style={styles.button}
        >
          <Text style={styles.buttonText}>{title}</Text>
        </Pressable>
      ))}
      {pending ? (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          正在连接作品…
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </ScrollView>
  );
}
