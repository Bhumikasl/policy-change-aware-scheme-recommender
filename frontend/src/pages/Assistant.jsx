import { useSearchParams } from "react-router-dom";
import { ChatProvider } from "../chat/ChatContext";
import ChatWindow from "../chat/ChatWindow";

/**
 * The standalone assistant page.
 *
 * `?schemeId=` scopes the conversation to one scheme, which is how the scheme
 * detail page links here — the question "am I eligible?" then needs no further
 * disambiguation.
 */
export default function Assistant() {
  const [params] = useSearchParams();
  const schemeId = params.get("schemeId");

  return (
    <div className="container" style={{ padding: "32px 0", maxWidth: 820 }}>
      <header style={{ marginBottom: 18 }}>
        <h2 style={{ margin: 0 }}>Scheme assistant</h2>
        <p style={{ color: "#555", margin: "6px 0 0" }}>
          {schemeId
            ? `Answering about ${schemeId}.`
            : "Ask about your eligibility, required documents, deadlines, or what changed recently."}
        </p>
      </header>

      <ChatProvider>
        <ChatWindow schemeId={schemeId} />
      </ChatProvider>
    </div>
  );
}
