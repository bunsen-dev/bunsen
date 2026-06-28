import { SiteHeader } from "@/components/SiteHeader";
import { Hero } from "@/components/Hero";
import { PipelineMap } from "@/components/PipelineMap";
import { Pillars } from "@/components/Pillars";
import { EvalAnything } from "@/components/EvalAnything";
import { DeepByDefault } from "@/components/DeepByDefault";
import { SetupExperiment } from "@/components/SetupExperiment";
import { TheLab } from "@/components/TheLab";
import { FinalCTA } from "@/components/FinalCTA";
import { SiteFooter } from "@/components/SiteFooter";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ waitlist?: string }>;
}) {
  const { waitlist } = await searchParams;
  return (
    <>
      <SiteHeader />
      <main id="top">
        <Hero />
        <PipelineMap />
        <EvalAnything />
        <SetupExperiment />
        <DeepByDefault />
        <TheLab />
        <Pillars />
        <FinalCTA waitlistStatus={waitlist} />
      </main>
      <SiteFooter />
    </>
  );
}
