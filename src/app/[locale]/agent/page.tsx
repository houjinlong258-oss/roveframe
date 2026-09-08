'use client';

import { useEffect, useRef, useState, Suspense } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Bot, Plus, Send, Square, Trash2, Crown, Boxes, Megaphone, HeartHandshake, Code2, ServerCog } from 'lucide-react';
import { useSSE } from '@/hooks/use-sse';
import { Markdown } from '@/components/markdown';
import { AgentCard } from '@/components/rove/agent-card';
import { cn, safeFetchJson } from '@/lib/utils';
import { fmtDateTime } from '@/lib/format';

type Session = { id: string; title: string; updated_at: string };
type Message = { id?: string; role: 'user' | 'assistant'; content: string };

function AgentChat() {
  const t = useTranslations('agent');
  const locale = useLocale();
  const searchParams = useSearchParams();
  const briefParam = searchParams.get('brief');

  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const { streaming, start, stop } = useSSE();
  const scrollRef = useRef<HTMLDivElement>(null);
  const insightSentRef = useRef(false);

  const quickQuestions = [t('quick1'), t('quick2'), t('quick3'), t('quick4'), t('quick5')];

  // AI 员工团队：AI-native 入口 —— 界面强调 Agents 而非菜单
  const team = [
    { key: 'ceo', name: t('team.ceo'), role: t('team.ceoRole'), icon: Crown },
    { key: 'ops', name: t('team.ops'), role: t('team.opsRole'), icon: Boxes },
    { key: 'mkt', name: t('team.mkt'), role: t('team.mktRole'), icon: Megaphone },
    { key: 'cust', name: t('team.cust'), role: t('team.custRole'), icon: HeartHandshake },
    { key: 'dev', name: t('team.dev'), role: t('team.devRole'), icon: Code2 },
    { key: 'devops', name: t('team.devops'), role: t('team.devopsRole'), icon: ServerCog },
  ] as const;

  const loadSessions = async () => {
    const d = await safeFetchJson('/api/agent/sessions');
    const list = d?.sessions ?? [];
    setSessions(list);
    return list;
  };

  const loadMessages = async (sessionId: string) => {
    const d = await safeFetchJson(`/api/agent/messages?session_id=${sessionId}`);
    setMessages(d?.messages ?? []);
  };

  useEffect(() => {
    loadSessions().then((list) => {
      if (list.length > 0) {
        setActiveId(list[0].id);
        loadMessages(list[0].id);
      }
    });
  }, []);

  // 从仪表盘洞察跳转：自动以洞察主题开场
  useEffect(() => {
    const insight = searchParams.get('insight');
    if (insight && !insightSentRef.current) {
      insightSentRef.current = true;
      send(insight);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const newChat = () => {
    stop();
    setActiveId(null);
    setMessages([]);
    setError('');
  };

  const deleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`/api/agent/sessions?id=${id}`, { method: 'DELETE' });
    const list = await loadSessions();
    if (activeId === id) {
      if (list.length > 0) {
        setActiveId(list[0].id);
        loadMessages(list[0].id);
      } else {
        newChat();
      }
    }
  };

  const send = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    setInput('');
    setError('');
    setMessages((prev) => [...prev, { role: 'user', content: trimmed }, { role: 'assistant', content: '' }]);

    await start({
      url: '/api/agent/chat',
      body: { session_id: activeId ?? undefined, message: trimmed, locale },
      onChunk: (chunk) => {
        setMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + chunk };
          return next;
        });
      },
      onDone: (headers) => {
        const newId = headers.get('X-Session-Id');
        if (newId && newId !== activeId) setActiveId(newId);
        loadSessions();
      },
      onError: (msg) => setError(msg),
    });
  };

  return (
    <div className="flex h-full -m-6">
      {/* 会话列表 */}
      <div className="w-72 shrink-0 border-r border-border/20 bg-card hidden lg:flex flex-col">
        <div className="p-4 border-b border-border/20">
          <button
            onClick={newChat}
            className="w-full bg-primary text-primary-foreground px-4 py-2.5 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all inline-flex items-center justify-center gap-2"
          >
            <Plus className="w-3.5 h-3.5" />{t('newChat')}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => { if (!streaming) { setActiveId(s.id); loadMessages(s.id); } }}
              className={cn(
                'w-full text-left px-3 py-2.5 rounded-md transition-colors group',
                activeId === s.id ? 'bg-muted' : 'hover:bg-muted/60'
              )}
            >
              <span className="flex items-center justify-between">
                <span className="text-sm font-medium truncate">{s.title}</span>
                <Trash2
                  className="w-3.5 h-3.5 text-muted-foreground/50 hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  onClick={(e) => deleteSession(s.id, e)}
                />
              </span>
              <span className="block text-xs text-muted-foreground mt-0.5">{fmtDateTime(s.updated_at, locale)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 对话区 */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6 space-y-5">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <span className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center mb-4 rove-rise">
                <Bot className="w-7 h-7 text-primary-foreground" />
              </span>
              <h1 className="text-xl font-bold font-display tracking-tight rove-rise rove-rise-1">{t('title')}</h1>
              <p className="text-sm text-muted-foreground mt-1.5 max-w-sm rove-rise rove-rise-2">{t('subtitle')}</p>

              {/* Your AI Team：点选一名 AI 员工直接开场 */}
              <p className="mt-8 mb-3 text-xs font-semibold tracking-widest uppercase text-muted-foreground rove-rise rove-rise-2">
                {t('yourTeam')}
              </p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 w-full max-w-3xl text-left">
                {team.map((a, i) => (
                  <AgentCard
                    key={a.key}
                    rise={((i % 4) + 1) as 1 | 2 | 3 | 4}
                    name={a.name}
                    role={a.role}
                    icon={a.icon}
                    status="active"
                    statusLabel={t('team.statusActive')}
                    action={
                      <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                        {t('team.openAgent')} →
                      </span>
                    }
                    onOpen={() => send(t(`team.kickoff.${a.key}` as 'team.kickoff.ceo'))}
                  />
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[70%] bg-primary text-primary-foreground rounded-xl rounded-br-sm px-4 py-3">
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">{m.content}</p>
                </div>
              </div>
            ) : (
              <div key={i} className="flex gap-3">
                <span className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shrink-0 mt-0.5">
                  <Bot className="text-primary-foreground w-4 h-4" />
                </span>
                <div className="max-w-[78%] bg-card rounded-xl rounded-tl-sm shadow-card px-5 py-4 min-w-0">
                  {m.content ? (
                    <Markdown content={m.content} />
                  ) : (
                    <span className="text-sm text-muted-foreground">{t('thinking')}</span>
                  )}
                  {streaming && i === messages.length - 1 && (
                    <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                      {t('generating')}
                      <button
                        onClick={stop}
                        className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-sm bg-muted hover:bg-muted/80 font-medium transition-colors"
                      >
                        <Square className="w-3 h-3" />{t('stopGenerating')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )
          )}
          {error && (
            <div className="flex gap-3">
              <span className="w-8 h-8 rounded-lg bg-destructive/15 text-destructive flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold">!</span>
              <div className="bg-destructive/10 text-destructive rounded-xl rounded-tl-sm px-5 py-3 text-sm">{error}</div>
            </div>
          )}
        </div>

        {/* 快捷问题 + 输入区 */}
        <div className="border-t border-border/20 bg-card px-6 py-4">
          <div className="flex gap-2 mb-3 overflow-x-auto pb-1">
            {quickQuestions.map((q) => (
              <button
                key={q}
                onClick={() => send(q)}
                disabled={streaming}
                className="shrink-0 px-3 py-1.5 rounded-full bg-muted hover:bg-muted/80 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-3">
            <textarea
              rows={2}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              placeholder={t('inputPlaceholder')}
              className="flex-1 bg-muted border-none rounded-md px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors resize-none"
            />
            <button
              onClick={() => send(input)}
              disabled={streaming || !input.trim()}
              className="bg-primary text-primary-foreground px-5 py-2.5 rounded-md text-sm font-medium hover:opacity-90 active:scale-[0.98] transition-all inline-flex items-center gap-2 shrink-0 disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />{t('send')}
            </button>
          </div>
          <p className="text-xs text-muted-foreground/70 mt-2">{t('dataContext')}</p>
        </div>
      </div>
    </div>
  );
}

export default function AgentPage() {
  return (
    <Suspense>
      <AgentChat />
    </Suspense>
  );
}
