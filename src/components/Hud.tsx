import type { PollState } from "../usePolling";
import type { ProviderResult } from "../providers/types";
import type { LocalAgents, PlanMode } from "../localAgents";
import { Carousel } from "./Carousel";

interface HudProps {
  poll: PollState;
  providers: ProviderResult[];
  local: LocalAgents | null;
  planMode: PlanMode;
  clickThrough: boolean;
  demo: boolean;
  gatewayUrl: string;
  dailyBudget: number;
  onOpenConfig: () => void;
  onOpenProviders: () => void;
  onHide: () => void;
}

export function Hud(p: HudProps) {
  return (
    <Carousel
      poll={p.poll}
      providers={p.providers}
      local={p.local}
      planMode={p.planMode}
      demo={p.demo}
      gatewayUrl={p.gatewayUrl}
      dailyBudget={p.dailyBudget}
      onOpenConfig={p.onOpenConfig}
      onOpenProviders={p.onOpenProviders}
      onHide={p.onHide}
    />
  );
}
