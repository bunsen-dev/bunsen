# NoAI API tour

A class-by-class map of the OpenTTD NoAI API surface you'll use, with the gotchas that bite.
Authoritative signatures: <https://docs.openttd.org/ai-api/>. Everything here is callable as your
company once `Start()` runs.

## Money — `AICompany`

- `SetLoanAmount(amount)` / `GetMaxLoanAmount()` / `GetLoanAmount()` — borrow to build. Amount must be
  a multiple of the loan interval and ≤ max.
- `GetBankBalance(AICompany.COMPANY_SELF)` — your cash. Check it before expensive builds.
- `SetName(name)`. `ResolveCompanyID(AICompany.COMPANY_SELF)` — your company id.
- Interest accrues on the loan, so an idle bot with a loan slowly goes bankrupt — build something that
  earns, or repay (`SetLoanAmount(0)`) while you're not using the capital.

## Finding work — `AITownList` / `AITown`, `AIIndustryList` / `AIIndustry`

- `AITownList()` → an `AIList` of towns. `AITown.GetLocation(t)` (a tile), `AITown.GetPopulation(t)`,
  `AITown.GetName(t)`. Bigger towns generate more passengers/mail.
- `AIIndustryList()` / `AIIndustry.GetLocation` / `GetAmountOfStationsAround` — for cargo (coal, wood,
  oil...). Industries pair a producer with an accepter; deliver from one to the other.
- Gotcha: `AITown.GetLocation` returns a central road tile, but not every town road tile is connected
  to it. Validate connectivity (or pathfind) before assuming a route works.

## Building roads — `AIRoad`

- `AIRoad.SetCurrentRoadType(AIRoad.ROADTYPE_ROAD)` before building (also `ROADTYPE_TRAM`).
- `BuildRoad(from, to)` builds a straight run between two tiles (must be alignable). Road vehicles
  **auto-pathfind on the connected road network**, so a route only needs the two stops to be *linked*
  by road — keep early routes on a town's existing roads (or between road-connected towns) and you may
  build little or no road yourself. No pathfinder library is preinstalled; for cross-map graph
  pathfinding, vendor one (`pathfinder.road` + `graph.aystar` + `queue.binary_heap`) into your package,
  or lay road tile-by-tile and handle `AIError` failures.
- `BuildRoadStation(tile, front, roadVehType, stationId)` /
  `BuildDriveThroughRoadStation(...)` — passenger/freight stops. `BuildRoadDepot(tile, front)` — where
  you buy/service vehicles. `front` is the adjacent tile vehicles enter from; get it wrong and the
  build fails.

## Building rail — `AIRail` (harder; do road first)

- `SetCurrentRailType`, `BuildRailStation`, `BuildRailDepot`, `BuildRail`, `BuildSignal`. Needs a rail
  pathfinder, correct depot/station orientation, and signaling to avoid deadlock. High payoff for
  bulk cargo, but get a road network working and profitable first.

## Vehicles & orders — `AIEngineList` / `AIEngine`, `AIVehicle`, `AIOrder`

- `AIEngineList(AIVehicle.VT_ROAD | VT_RAIL | VT_WATER | VT_AIR)` → buyable engines. Filter with
  valuators: `AIEngine.GetCapacity`, `GetPrice`, `GetMaxSpeed`, `CanRefitCargo`,
  `GetCargoType`/`HasPowerOnRail`. Never assume engine id 0.
- `AIVehicle.BuildVehicle(depot, engine)` → a vehicle id (check validity). `RefitVehicle` for cargo.
  `StartStopVehicle`, `SendVehicleToDepot`, `GetProfitThisYear` / `GetProfitLastYear` (sell the losers).
- `AIOrder.AppendOrder(vehicle, destTile, flags)` — chain stops. Flags include
  `AIOrder.OF_FULL_LOAD_ANY` (wait to fill at the producer) and `AIOrder.OF_NONE` (drop and go).

## Cargo — `AICargoList` / `AICargo`

- `AICargoList()` → cargo types. Identify by class, never by id: `AICargo.HasCargoClass(cargo,
  AICargo.CC_PASSENGERS)` (also `CC_MAIL`, `CC_EXPRESS`, bulk classes). `GetCargoIncome(cargo, dist,
  days)` estimates payment — longer hauls of high-value cargo pay more, up to a point.

## Tiles, distance, lists — `AIMap` / `AITile`, `AIList`

- `AIMap.DistanceManhattan(a, b)` / `DistanceMax`, `AIMap.GetTileIndex(x, y)`, `GetTileX/Y`.
- `AITile.IsBuildable`, `GetSlope`, `IsWaterTile`, `DemolishTile`. Note the buildable area starts at
  (1,1) — map edges (x or y = 0 or max) are not buildable.
- `AIList` is the workhorse collection. `Valuate(AISomething.SomeGetter [, args])` tags each item with
  a number, then `Sort(AIList.SORT_BY_VALUE, AIList.SORT_DESCENDING)` and iterate
  `for (local i = list.Begin(); !list.IsEnd(); i = list.Next())`. Valuators that call into C++ can be
  expensive on big lists — `Sleep` if you valuate a lot.

## Errors & timing

- After any command, `AIError.GetLastError()` / `AIError.GetLastErrorString()` tells you why it failed
  (not enough money, area not clear, vehicle limit, etc.). Branch on it instead of assuming success.
- `AIController.GetTick()` returns 1 on the first `Start()` call — don't use it for absolute timing;
  use `AIDate.GetCurrentDate()` for in-game dates.
- `AIController.Sleep(ticks)` suspends you for that many game ticks (and resets the opcode counter).

## The shape of a robust bot

Found + capitalize → find a producer/accepter (or two towns) → cost-checked build of stations + depot
+ connection → buy a correctly-refitted vehicle with orders → start it → loop: monitor profit, add
vehicles to winners, prune losers, open new routes, manage the loan. Keep every loop iteration cheap
and always `Sleep`.
