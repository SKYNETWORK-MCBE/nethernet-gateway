import * as v from 'valibot';

export const minecraftIdentityClaimEntries = {
  xid: v.pipe(v.string(), v.nonEmpty()),
  mid: v.pipe(v.string(), v.nonEmpty()),
  xname: v.pipe(v.string(), v.nonEmpty()),
};

export const minecraftIdentityClaimsSchema = v.object(minecraftIdentityClaimEntries);

export function normalizeMinecraftIdentityClaims(
  claims: v.InferOutput<typeof minecraftIdentityClaimsSchema>,
): { xuid: string; playFabId: string; gamertag: string } {
  return {
    xuid: claims.xid,
    playFabId: claims.mid,
    gamertag: claims.xname,
  };
}
