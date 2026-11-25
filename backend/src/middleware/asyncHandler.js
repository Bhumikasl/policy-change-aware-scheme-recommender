/**
 * Wrap an async route handler so a rejected promise reaches Express's error
 * middleware instead of becoming an unhandled rejection.
 *
 * Express 4 does not await route handlers. `router.get("/x", async (req,res)=>{
 * throw new Error() })` produces an UnhandledPromiseRejection: the client hangs
 * until timeout and, on modern Node, the process can terminate. Wrapping is the
 * standard fix and is why every route in this codebase now goes through it.
 *
 *   router.get("/x", asyncHandler(async (req, res) => { ... }));
 */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
