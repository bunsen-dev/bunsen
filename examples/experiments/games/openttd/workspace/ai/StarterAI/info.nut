/*
 * StarterAI — registration + metadata for the OpenTTD NoAI Squirrel bot.
 *
 * This file tells OpenTTD how to load your AI. The engine scans `ai/<dir>/`
 * for an `info.nut`, evaluates it, and calls RegisterAI() to register the
 * class below. Get any of the load-bearing fields wrong and the AI silently
 * fails to load (the company never appears) — so most of these are fixed.
 *
 * You generally do NOT need to edit this file. Put your logic in main.nut.
 * The few fields that matter for loading are called out inline.
 */
class StarterAI extends AIInfo {
  function GetAuthor()       { return "Bunsen"; }
  function GetName()         { return "StarterAI"; }          // `start_ai StarterAI`
  function GetShortName()    { return "BNSN"; }               // MUST be exactly 4 chars
  function GetDescription()  { return "Road-based starter bot for the Bunsen OpenTTD experiment"; }
  function GetVersion()      { return 1; }
  function GetDate()         { return "2026-06-25"; }
  function CreateInstance()  { return "StarterAI"; }          // MUST equal the class name in main.nut
  function GetAPIVersion()   { return "15"; }                 // MUST match the engine major (OpenTTD 15.x)
  function MinVersionToLoad(){ return 1; }

  // Optional: declare tunable settings here (exposed to `start_ai StarterAI x=1`).
  // The starter ships none; add them if your strategy benefits from parameters.
  function GetSettings() {}
}

RegisterAI(StarterAI());
