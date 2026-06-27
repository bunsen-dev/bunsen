/*
 * BunsenReporter — the authoritative metrics reader.
 *
 * This is a verifier-owned AI baked into the experiment image; it is NOT the
 * agent's code and the agent cannot edit it. It runs as its own company and
 * reads the *other* company's quarterly scoreboard (performance rating, company
 * value, cargo delivered) straight from authoritative game state, then emits it
 * to stderr as `METRIC ...` lines for the scorer to parse. Because OpenTTD's
 * AICompany quarterly accessors carry no caller-identity restriction, a separate
 * company can read the agent's numbers — so the agent can never spoof its score.
 */
class BunsenReporter extends AIInfo {
  function GetAuthor()       { return "Bunsen"; }
  function GetName()         { return "BunsenReporter"; }
  function GetShortName()    { return "BREP"; }
  function GetDescription()  { return "Reads the agent company's authoritative metrics (Bunsen scorer)"; }
  function GetVersion()      { return 1; }
  function GetDate()         { return "2026-06-26"; }
  function CreateInstance()  { return "BunsenReporter"; }
  function GetAPIVersion()   { return "15"; }
  function MinVersionToLoad(){ return 1; }
}
RegisterAI(BunsenReporter());
