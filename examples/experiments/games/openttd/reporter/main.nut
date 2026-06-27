/*
 * BunsenReporter::Start — emit the agent company's authoritative metrics.
 *
 * Start order is fixed by the harness: `start_ai StarterAI` (the agent, the
 * first/lowest company slot) then `start_ai BunsenReporter` (this). So the
 * "agent company" is simply the first valid company that is not ourselves.
 *
 * Each in-game quarter we print one machine-readable line to stderr (via
 * AILog.Info under `-d script=4`):
 *
 *   METRIC agent=<id> year=<y> quarter=<q> rating=<0..1000> value=<money> \
 *          cargo=<units> balance=<money> bankrupt=<0|1>
 *
 * The scorer parses the LAST such line as the final result. If the agent never
 * founds a company (its bot failed to compile/register), we print
 * `METRIC agent_missing=1` so the scorer's gate can distinguish "never built"
 * from "built but weak".
 */
class BunsenReporter extends AIController {
  constructor() {}

  function FindAgentCompany() {
    local self = AICompany.ResolveCompanyID(AICompany.COMPANY_SELF);
    for (local c = 0; c < 15; c++) {
      local cid = AICompany.ResolveCompanyID(c);
      if (cid != AICompany.COMPANY_INVALID && cid != self) return cid;
    }
    return AICompany.COMPANY_INVALID;
  }

  function Start() {
    AICompany.SetName("BunsenReporter");
    local last_q = -1;
    while (true) {
      local d = AIDate.GetCurrentDate();
      local q = AIDate.GetYear(d) * 4 + (AIDate.GetMonth(d) - 1) / 3;
      if (q != last_q) {
        last_q = q;
        local agent = FindAgentCompany();
        if (agent == AICompany.COMPANY_INVALID) {
          AILog.Info("METRIC agent_missing=1 year=" + AIDate.GetYear(d));
        } else {
          // quarter=1 => the most recently *closed* quarter (always well-defined).
          local rating  = AICompany.GetQuarterlyPerformanceRating(agent, AICompany.CURRENT_QUARTER + 1);
          local value   = AICompany.GetQuarterlyCompanyValue(agent, AICompany.CURRENT_QUARTER + 1);
          local cargo   = AICompany.GetQuarterlyCargoDelivered(agent, AICompany.CURRENT_QUARTER + 1);
          local balance = AICompany.GetBankBalance(agent);
          AILog.Info("METRIC agent=" + agent
            + " year=" + AIDate.GetYear(d)
            + " quarter=" + q
            + " rating=" + rating
            + " value=" + value
            + " cargo=" + cargo
            + " balance=" + balance
            + " bankrupt=0");
        }
      }
      this.Sleep(74);   // ~one in-game day; cheap, plenty fine-grained for quarterly sampling
    }
  }

  function Save() { return {}; }
  function Load(version, data) {}
}
