// The cue artwork as components: flags, stablecoin and network logos, and the SWIFT globe. They
// draw the art only, always aria-hidden: the code or name is printed beside the cue, and @fin/ui's
// Flag, AssetIcon, NetworkIcon and RailIcon add the size, the ring and the unknown-value fallback.
import { type ReactElement, useId } from "react";
import {
  type CueArt,
  type FlagCode,
  flagArt,
  globeArt,
  type NetworkCode,
  networkArt,
  type TokenCode,
  tokenArt,
} from "./cues.ts";
import { renderNodes } from "./svg-node.ts";

type CueProps = { size?: number; className?: string };

function CueSvg(props: CueProps & { art: CueArt; kind: string }): ReactElement {
  // useId gives a stable id per instance; React's ":" characters are not valid in url(#...).
  const prefix = `fin-${props.kind}-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const size = props.size ?? 16;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={props.art.viewBox}
      {...(props.art.fill === undefined ? {} : { fill: props.art.fill })}
      aria-hidden="true"
      focusable="false"
      className={props.className}
      data-cue={props.kind}
    >
      {renderNodes(props.art.children, prefix)}
    </svg>
  );
}

export function FlagArt(props: CueProps & { code: FlagCode }): ReactElement {
  return <CueSvg {...props} art={flagArt[props.code]} kind={`flag-${props.code.toLowerCase()}`} />;
}

export function GlobeArt(props: CueProps): ReactElement {
  return <CueSvg {...props} art={globeArt} kind="globe" />;
}

export function TokenArt(props: CueProps & { code: TokenCode }): ReactElement {
  return (
    <CueSvg {...props} art={tokenArt[props.code]} kind={`token-${props.code.toLowerCase()}`} />
  );
}

export function NetworkArt(props: CueProps & { code: NetworkCode }): ReactElement {
  return (
    <CueSvg {...props} art={networkArt[props.code]} kind={`network-${props.code.toLowerCase()}`} />
  );
}

export const flagCodes = Object.keys(flagArt) as FlagCode[];
export const tokenCodes = Object.keys(tokenArt) as TokenCode[];
export const networkCodes = Object.keys(networkArt) as NetworkCode[];

export function isFlagCode(value: string): value is FlagCode {
  return Object.hasOwn(flagArt, value);
}
export function isTokenCode(value: string): value is TokenCode {
  return Object.hasOwn(tokenArt, value);
}
export function isNetworkCode(value: string): value is NetworkCode {
  return Object.hasOwn(networkArt, value);
}
