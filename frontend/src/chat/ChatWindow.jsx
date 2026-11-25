import { useEffect, useRef, useState } from "react";
import api from "../api/client";
import { useChat } from "./ChatContext";
import ChatMessage from "./ChatMessage";

/**
 * The chat surface.
 *
 * Usable on its own page or embedded in a scheme detail view — when a
 * `schemeId` is passed, every question is scoped to that scheme, so "am I
 * eligible?" needs no further disambiguation.
 *
 * Every state is rendered explicitly: empty, sending, error, answered. A chat
 * box that shows nothing while it waits reads as broken.
 */
export default function ChatWindow({ schemeId = null, title = "Ask about schemes" }) {
  const { messages, send, isSending, error, reset } = useChat();
  const [draft, setDraft] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const endRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/chat/suggestions", { params: schemeId ? { schemeId } : {} })
      .then(({ data }) => {
        if (!cancelled) setSuggestions(data.suggestions || []);
      })
      // Starter questions are a convenience. Failing to load them is not worth
      // an error message the person cannot act on.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [schemeId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, isSending]);

  function submit(e) {
    e?.preventDefault();
    const text = draft.trim();
    if (!text || isSending) return;
    setDraft("");
    send(text, schemeId);
  }

  return (
    <section
      style={{
        border: "1px solid #E3E1DA",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 420,
        background: "#fff",
      }}
    >
      <header
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid #EEE",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <strong style={{ fontSize: 15 }}>{title}</strong>
        {messages.length > 0 && (
          <button
            onClick={reset}
            style={{
              background: "transparent",
              border: "1px solid #CCC",
              borderRadius: 4,
              padding: "3px 10px",
              cursor: "pointer",
              fontSize: 13,
              color: "#555",
            }}
          >
            Clear
          </button>
        )}
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        {messages.length === 0 && (
          <div style={{ color: "#666", fontSize: 14 }}>
            <p style={{ marginTop: 0 }}>
              Ask about eligibility, documents, deadlines, or what recently changed. Answers
              come from verified scheme data — eligibility is decided by the rules engine, not
              by the assistant.
            </p>
            {suggestions.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
                {suggestions.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s, schemeId)}
                    disabled={isSending}
                    style={{
                      background: "#F4F3EF",
                      border: "1px solid #DDD",
                      borderRadius: 16,
                      padding: "6px 12px",
                      cursor: isSending ? "default" : "pointer",
                      fontSize: 13,
                      color: "#333",
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {messages.map((m) => (
          <ChatMessage key={m.id} message={m} />
        ))}

        {isSending && (
          <p style={{ color: "#777", fontSize: 14, fontStyle: "italic" }} aria-live="polite">
            Checking verified scheme data…
          </p>
        )}
        <div ref={endRef} />
      </div>

      {error && (
        <p
          role="alert"
          style={{
            margin: 0,
            padding: "8px 16px",
            background: "#FDF3F2",
            color: "#8A2B22",
            fontSize: 13,
            borderTop: "1px solid #E7C3C0",
          }}
        >
          {error}
        </p>
      )}

      <form
        onSubmit={submit}
        style={{ display: "flex", gap: 8, padding: 12, borderTop: "1px solid #EEE" }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Am I eligible for this scheme?"
          maxLength={1000}
          aria-label="Your question"
          style={{
            flex: 1,
            padding: "9px 12px",
            border: "1px solid #CCC",
            borderRadius: 6,
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={isSending || !draft.trim()}
          style={{
            background: isSending || !draft.trim() ? "#BBB" : "var(--color-primary, #1B3A2F)",
            color: "#FAF9F6",
            border: "none",
            borderRadius: 6,
            padding: "9px 18px",
            cursor: isSending || !draft.trim() ? "default" : "pointer",
            fontSize: 14,
          }}
        >
          {isSending ? "…" : "Ask"}
        </button>
      </form>
    </section>
  );
}
