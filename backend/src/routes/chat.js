const express = require("express");
const rateLimit = require("express-rate-limit");
const asyncHandler = require("../middleware/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const { badRequest } = require("../middleware/errorHandler");
const { handleChat } = require("../services/chatService");

const router = express.Router();

/**
 * POST /api/chat — the conversational agent.
 *
 * ---------------------------------------------------------------------------
 * AUTHENTICATION AND USER ISOLATION
 * ---------------------------------------------------------------------------
 * `requireAuth` is unconditional. Every answer this route can produce is
 * personal — an eligibility verdict is computed against the caller's income,
 * age and category, and the policy-change answers read their recommendation
 * history.
 *
 * The caller's identity comes from `req.user.sub`, set by the JWT middleware
 * from a signed token. The body is never consulted for it. That is enforced
 * structurally rather than by validation: the handler passes `req.user.sub` as
 * the `userId` argument, and `handleChat` has no other way to choose a user, so
 * a body containing `{"userId": "<someone else>"}` has nowhere to go. It is not
 * rejected — it is simply never read, which is the stronger property, since a
 * rejection list has to anticipate the field name and this does not.
 *
 * ---------------------------------------------------------------------------
 * RATE LIMIT
 * ---------------------------------------------------------------------------
 * Tighter than the global 300/15min. Each call can trigger an embedding
 * request and an LLM generation, so an unbounded caller costs real quota, and
 * a chat endpoint is the natural place to attempt prompt extraction by
 * repetition.
 */
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.CHAT_RATE_LIMIT_MAX) || 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Per authenticated user rather than per IP: several students behind one
  // college NAT are not one abusive caller.
  keyGenerator: (req) => (req.user && req.user.sub) || req.ip,
  message: { error: "Too many chat requests, please slow down" },
});

router.post(
  "/chat",
  requireAuth,
  chatLimiter,
  asyncHandler(async (req, res) => {
    const { message, schemeId, history, language } = req.body || {};

    if (typeof message !== "string" || !message.trim()) {
      throw badRequest("message is required");
    }
    if (schemeId != null && typeof schemeId !== "string") {
      throw badRequest("schemeId must be a string");
    }
    if (history != null && !Array.isArray(history)) {
      throw badRequest("history must be an array");
    }
    if (language != null && !/^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(String(language))) {
      throw badRequest("language must be a BCP-47 tag such as 'en'");
    }

    const out = await handleChat({
      // THE identity. Verified token subject, never the request body.
      userId: req.user.sub,
      message,
      schemeId: schemeId || null,
      history: history || [],
      language: language || "en",
    });

    if (!out.ok) throw badRequest(out.error);
    res.json({ response: out.response, turn: out.turn });
  })
);

/**
 * GET /api/chat/suggestions — the starter questions the UI offers.
 *
 * Authenticated because the list is scheme-aware when a schemeId is given, and
 * because an unauthenticated chat surface would invite people to type personal
 * details into a route that cannot answer them.
 */
router.get(
  "/chat/suggestions",
  requireAuth,
  asyncHandler(async (req, res) => {
    const schemeId = typeof req.query.schemeId === "string" ? req.query.schemeId : null;
    res.json({
      suggestions: schemeId
        ? [
            "Am I eligible for this scheme?",
            "Why am I not eligible?",
            "What documents are required?",
            "What is the application deadline?",
            "What changed in this scheme?",
          ]
        : [
            "Which schemes are recommended for me?",
            "Which schemes changed recently?",
            "Why did my recommendation change?",
          ],
      schemeId,
    });
  })
);

module.exports = router;
