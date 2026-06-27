---
name: openttd-bot
description: >-
  Write and iterate an OpenTTD NoAI Squirrel bot (an AIController in ai/StarterAI/main.nut) that runs
  a transport company — found the company, connect towns/industries with road or rail, run vehicles,
  deliver cargo, and grow. Use when authoring or debugging an OpenTTD AI for the Bunsen `openttd`
  experiment: covers the NoAI API surface (AICompany/AIRoad/AIRail/AIVehicle/AIStation/AIOrder/
  AITown/AIEngine/AICargo/AIMap/AITile/AIList), the test-then-execute build pattern, the fatal
  pitfalls that silently kill a bot, and the `openttd-playtest` feedback loop.
---

# Authoring an OpenTTD NoAI Squirrel bot

You control a company in OpenTTD by writing an **AI** in Squirrel against the game's **NoAI API**.
Your bot is a class extending `AIController` whose `Start()` runs for the life of the game. You issue
build/buy/order commands through `AI*` classes; the engine executes them as your company.

Your package lives in **`ai/StarterAI/`**: `info.nut` (registration — don't touch the load-bearing
fields) and `main.nut` (your logic). The harness launches it with `start_ai StarterAI`, so its
`GetName()`/`CreateInstance()` must stay `"StarterAI"`.

Authoritative API reference: <https://docs.openttd.org/ai-api/> · NoAI intro:
<https://wiki.openttd.org/en/Development/Script/Introduction>. This skill is the fast path; consult
the docs for exact signatures.

## The build loop

Iterate constantly with the **same deterministic sim the scorer uses**:

```sh
openttd-playtest                                  # full scored horizon
OPENTTD_HORIZON_YEARS=2 openttd-playtest   # fast iteration while building
```

It prints whether your bot **compiled and registered**, then the final **performance rating
(0–1000)**, **company value**, and **cargo delivered**, and writes `./openttd-out/metrics.json` and
`final.sav`. If it didn't compile/register, fix that first — there is no partial credit for a bot
that won't load.

## Five rules that silently kill a bot

1. **`Start()` must never return.** End it with an infinite loop containing `this.Sleep(n)`. If
   `Start()` returns, your bot is dead and the company just sits there.
2. **Call `this.Sleep(n)` regularly** (e.g. every loop iteration, `n` ≈ 50–100). OpenTTD suspends a
   script that runs too many opcodes without sleeping; `Sleep` resets that counter. Long scans
   (pathfinding, iterating big lists) without a `Sleep` will get you killed.
3. **Test, then execute.** Most build calls cost money and can fail. Check feasibility/cost inside an
   `AITestMode` scope first, then do it for real in `AIExecMode`:
   ```squirrel
   { local t = AITestMode(); if (!AIRoad.BuildRoadStation(tile, front, ...)) continue; }
   { local e = AIExecMode(); AIRoad.BuildRoadStation(tile, front, ...); }
   ```
4. **Re-check validity right before building.** The world changes between ticks; a tile you found
   last loop may be gone. Check `AIError.GetLastError()` after commands and handle failure.
5. **Never hard-code IDs.** Engine, cargo, and town IDs vary by game/NewGRF. Discover them at runtime
   (`AIEngineList`, `AICargoList`, `AICargo.HasCargoClass`, `AITownList`).

## A first profitable route (road buses — start here)

Road is far simpler than rail (no signaling, trivial stations). Build ONE working route, confirm it
turns a profit in `openttd-playtest`, then expand. Sketch:

```squirrel
function StarterAI::Start() {
  AICompany.SetName("StarterAI");
  AICompany.SetLoanAmount(AICompany.GetMaxLoanAmount());   // capital to build with
  AIRoad.SetCurrentRoadType(AIRoad.ROADTYPE_ROAD);

  // 1. Pick two sizeable towns a sensible distance apart.
  local towns = AITownList();
  towns.Valuate(AITown.GetPopulation);
  towns.Sort(AIList.SORT_BY_VALUE, AIList.SORT_DESCENDING);
  local a = towns.Begin();                 // biggest town
  // ...choose b among the next few towns with DistanceManhattan in a useful range...

  // 2. Near each town centre (AITown.GetLocation), find a tile where a drive-through
  //    or bay road station builds (AIRoad.BuildRoadStation / BuildDriveThroughRoadStation),
  //    cost-checked in AITestMode. Build a depot near one end (AIRoad.BuildRoadDepot).

  // 3. Connect the two stations with road. Road vehicles AUTO-PATHFIND on the
  //    connected road network, so you only need a road that *links* the two stops:
  //    build both stops on a town's existing road network (intra-town, or two towns
  //    already road-connected) and you may not need to build any road at all;
  //    otherwise lay road tile-by-tile with AIRoad.BuildRoad and handle failures.
  //    (No pathfinder library is preinstalled; vendor one into ai/StarterAI/ if you
  //    want graph-based pathfinding, or keep routes on connected road.)

  // 4. Buy a passenger road vehicle and set its orders:
  local engines = AIEngineList(AIVehicle.VT_ROAD);
  engines.Valuate(AIEngine.GetCapacity);            // and filter to a passenger engine
  // local bus = AIVehicle.BuildVehicle(depot, engine);
  // AIOrder.AppendOrder(bus, stopA, AIOrder.OF_FULL_LOAD_ANY);
  // AIOrder.AppendOrder(bus, stopB, AIOrder.OF_NONE);
  // AIVehicle.StartStopVehicle(bus);

  // 5. Management loop: add buses to busy routes, sell unprofitable vehicles
  //    (AIVehicle.GetProfitLastYear), open new routes, repay/borrow as needed.
  while (true) {
    // ...manage + expand...
    this.Sleep(100);
  }
}
```

### Exact names for a road route (get these right — wrong constants are a runtime crash)

```squirrel
AIRoad.SetCurrentRoadType(AIRoad.ROADTYPE_ROAD);
// road vehicle type is ROADVEHTYPE_BUS / ROADVEHTYPE_TRUCK  (NOT "ROADVEH_TYPE_*")
AIRoad.BuildRoadStation(tile, front, AIRoad.ROADVEHTYPE_BUS, AIStation.STATION_NEW);
AIRoad.BuildDriveThroughRoadStation(tile, front, AIRoad.ROADVEHTYPE_BUS, AIStation.STATION_NEW);
AIRoad.BuildRoadDepot(tile, front);                 // `front` = adjacent tile the vehicle exits to
local engines = AIEngineList(AIVehicle.VT_ROAD);    // VT_ROAD, then filter to a passenger engine
local bus = AIVehicle.BuildVehicle(depot, engine);  // check AIVehicle.IsValidVehicle(bus)
AIOrder.AppendOrder(bus, stopA, AIOrder.OF_FULL_LOAD_ANY);
AIOrder.AppendOrder(bus, stopB, AIOrder.OF_NONE);
AIVehicle.StartStopVehicle(bus);
AICargoList();  // pick passengers via AICargo.HasCargoClass(c, AICargo.CC_PASSENGERS)
```

Any build call can fail — wrap each in `AITestMode` first, then `AIExecMode`, and read
`AIError.GetLastErrorString()` on failure. A reference type or constant you're unsure of: print it
(`AILog.Info(AIRoad.ROADVEHTYPE_BUS)`) or check `docs.openttd.org/ai-api/` rather than guessing.

See [`reference/api-tour.md`](reference/api-tour.md) for the class-by-class map of what you'll use
(towns/industries, building road & rail, vehicles & orders, money, lists & valuators, errors) and
the common gotchas (map edges, connectivity, cargo classes, `GetTick` quirks).

## What to optimize for

You are scored on OpenTTD's **performance rating** (0–1000), gated on **staying solvent**. That one
rating already folds in company value, cargo delivered, cargo *variety*, busy stations, profitable
vehicles, and a low loan — so it's the single number that matters, and the winning move is a
*network that actually moves cargo at a profit*, not a sprawl of idle infrastructure. Get one route
profitable, then compound: more vehicles on proven routes, then more routes, then rail for
high-volume bulk cargo and more cargo types (variety lifts the rating). Company value and cargo
delivered are still printed by the playtest for insight, but the rating is what's graded.
