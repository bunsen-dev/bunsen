import { SiteHeader } from "@/components/SiteHeader";
import { Hero } from "@/components/Hero";
import { PipelineMap } from "@/components/PipelineMap";
import { Pillars } from "@/components/Pillars";
import { Quickstart } from "@/components/Quickstart";
import { DeepEvals } from "@/components/DeepEvals";
import { AtScale } from "@/components/AtScale";
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
        <Pillars />
        <Quickstart />
        <DeepEvals />
        <AtScale />
        <TheLab />
        <FinalCTA waitlistStatus={waitlist} />
      </main>
      <SiteFooter />
    </>
  );
}
