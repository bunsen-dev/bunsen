/*
 * StarterAI — your OpenTTD transport company, written against the NoAI API.
 *
 * THIS IS YOUR DELIVERABLE. Edit this file (and add helpers under ai/StarterAI/)
 * to build a profitable transport network. The simulation runs headless for a
 * fixed number of in-game years; you are then scored on authoritative game state
 * read straight from the savegame — performance rating (0–1000), company value,
 * cargo delivered, and network breadth. You cannot fabricate those numbers; the
 * scorer re-runs your bot from a fixed seed and reads them from the engine.
 *
 * What ships here: a bot that founds the company and stays solvent but builds
 * NOTHING — so out of the box it passes the "not bankrupt" gate and scores low
 * on everything else. Your job is to make it actually move cargo. The README in
 * the workspace and the `openttd-bot` skill explain the API and the build loop.
 *
 * THREE RULES that, if broken, silently kill your bot (see the skill for why):
 *   1. Start() must never return — keep an infinite loop with this.Sleep(...).
 *   2. Call this.Sleep(n) regularly; without it you hit the opcode limit.
 *   3. Cost-check with AITestMode before committing builds with AIExecMode.
 *
 * Split logic into more files as you grow — add `require("helpers.nut");` above
 * the class and drop a helpers.nut beside this file. The starter keeps it to one
 * self-contained file so it always loads cleanly.
 */
class StarterAI extends AIController {
  // Cached engine/state you accumulate as you build. Add your own fields here.
  constructor() {}

  function Start();
  function Save() { return {}; }              // persist strategy state across saves if you need it
  function Load(version, data) {}
}

function StarterAI::Start() {
  // --- Found + name the company. ---------------------------------------------
  // We leave the starting cash untouched so the do-nothing baseline stays solvent
  // for the whole horizon. When YOU start building, borrow capital first:
  //   AICompany.SetLoanAmount(AICompany.GetMaxLoanAmount());
  AICompany.SetName("StarterAI");
  AILog.Info("StarterAI: company founded. Balance=" + AICompany.GetBankBalance(AICompany.COMPANY_SELF));

  // ---------------------------------------------------------------------------
  // TODO(you): build a transport network. A first profitable ROAD bus route:
  //
  //   1. Borrow capital:        AICompany.SetLoanAmount(AICompany.GetMaxLoanAmount())
  //   2. Pick two towns:        scan AITownList(), pick a pair a sensible distance
  //                             apart (AIMap.DistanceManhattan(a, b)); bigger towns
  //                             (AITown.GetPopulation) generate more passengers.
  //   3. Find buildable stops:  near each town centre (AITown.GetLocation), find a
  //                             road tile where AIRoad.BuildRoadStation succeeds
  //                             (cost-check in AITestMode first).
  //   4. Connect them:          build road between the stops. Real bots use the
  //                             Road Pathfinder library (bundled in this image as
  //                             `import("pathfinder.road", ...)`) — see the skill.
  //   5. Add a depot + bus:     AIRoad.BuildRoadDepot, then AIEngineList(VT_ROAD)
  //                             to choose a passenger engine, AIVehicle.BuildVehicle.
  //   6. Orders + go:           AIOrder.AppendOrder(stopA, FULL_LOAD), then stopB,
  //                             then AIVehicle.StartStopVehicle.
  //   7. Manage + expand:       in the loop below, add buses to busy routes, sell
  //                             unprofitable vehicles, and open new routes.
  //
  // helpers.nut has small utilities to get you started. Grow them as you go.
  // ---------------------------------------------------------------------------

  local ticks = 0;
  while (true) {
    // TODO(you): your per-cycle management goes here (build, expand, prune).
    this.Sleep(100);                          // REQUIRED: yield + reset the opcode counter
    ticks += 100;
  }
}
