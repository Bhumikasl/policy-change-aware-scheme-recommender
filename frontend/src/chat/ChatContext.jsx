import { createContext, useCallback, useContext, useMemo, useState } from "react";
import api from "../api/client";

/**
 * Conversation state for the scheme assistant.
 *
 * ---------------------------------------------------------------------------
 * THE CLIENT SENDS NO IDENTITY
 * ---------------------------------------------------------------------------
 * There is no user id, email or profile field in any request below. The server
 * derives the caller from the verified JWT the axios interceptor attaches, so
 * there is nothing here for anyone to tamper with — the same rule the
 * notification client follows, and for the same reason: an eligibility answer
 * is computed from income, age and category, and a client-supplied id would
 * make that readable for any account whose id could be guessed.
 *
 * ---------------------------------------------------------------------------
 * HISTORY IS CLIENT-HELD AND DELIBERATELY THIN
 * ---------------------------------------------------------------------------
 * The server stores no transcript. Each turn the client replays a short list of
 * `{intent, schemeId}` — enough for the server to resolve "why?" against the
 * previous question, and nothing more. Message TEXT is never sent back, so a
 * conversation in which someone typed something personal does not become a
 * payload that keeps re-transmitting it.
 */
const ChatContext = createContext(null);

/** Matches the server's own bound. Sending more would simply be trimmed. */
const MAX_TURNS = 6;

let nextId = 1;
const newId = () => `m${nextId++}`;

export function ChatProvider({ children }) {
  const [messages, setMessages] = useState([]);
  // idle | sending | error
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [turns, setTurns] = useState([]);

  const reset = useCallback(() => {
    setMessages([]);
    setTurns([]);
    setStatus("idle");
    setError("");
  }, []);

  const send = useCallback(
    async (text, schemeId = null) => {
      const question = String(text || "").trim();
      if (!question || status === "sending") return;

      setError("");
      setStatus("sending");
      setMessages((prev) => [...prev, { id: newId(), role: "user", text: question }]);

      try {
        const { data } = await api.post("/chat", {
          message: question,
          schemeId: schemeId || undefined,
          history: turns.slice(-MAX_TURNS),
        });

        const r = data.response || {};
        setMessages((prev) => [
          ...prev,
          {
            id: newId(),
            role: "assistant",
            text: r.answer || "",
            grounded: !!r.grounded,
            degraded: !!r.degraded,
            // Which thing degraded, so the notice can say so instead of
            // guessing "some services were unavailable".
            degradedReasons: r.degradedReasons || [],
            sources: r.sources || [],
            eligibilityDecision: r.eligibilityDecision || null,
            recommendationContext: r.recommendationContext || null,
            schemeIds: r.schemeIds || [],
          },
        ]);
        if (data.turn) setTurns((prev) => [...prev, data.turn].slice(-MAX_TURNS));
        setStatus("idle");
      } catch (err) {
        const message =
          err.friendlyMessage || "The assistant is unavailable right now. Please try again.";
        setError(message);
        setStatus("error");
        // The failed question stays on screen so the person can see what was
        // asked and retry it, rather than watching their text disappear.
        setMessages((prev) => [
          ...prev,
          { id: newId(), role: "assistant", text: message, failed: true },
        ]);
      }
    },
    [status, turns]
  );

  const value = useMemo(
    () => ({ messages, status, error, send, reset, isSending: status === "sending" }),
    [messages, status, error, send, reset]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used inside a ChatProvider");
  return ctx;
}
