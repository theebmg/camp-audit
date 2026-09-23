# Addendum §5a — Asset type icons and profile photos

Branch `asset-profile-5a`. No dependency on the audit engine. Migration `0084`,
**not applied**.

## The correction that shaped this

The obvious reading of "default icon per asset type" is `building_types` — it's a real
table with 7 sensible rows (Cabin, Lodge/Hotel, Tabernacle…). I built it that way first,
then checked the data:

```
assets with NO building_type_id:  338 of 340
asset_type populated on:          338 of 340
   118 Full Cabin · 117 Room · 25 RV Site · 21 Half Cabin · 17 Camp Building
    14 Restrooms ·   6 Showers ·  5 Bath House ·  4 Tractor ·  4 Tabernacle …
```

`building_types` is effectively unused. Hanging icons there would have given **338 of
340 buildings the same grey fallback** — the exact problem the feature exists to solve.
The addendum's own examples ("cabin, camp building, tabernacle") are `asset_type` values,
which is the giveaway in hindsight.

So icons key off `asset_type`. Verified: **338 of 340 assets resolve to a real icon**;
the 2 that don't have no `asset_type` at all and fall back.

## Shape

- **`asset_type_icons`** (`asset_type` PK, `icon`, `sort_order`). `asset_type` is free
  text on `assets`, so the icons need their own table to be admin-editable — the same
  rule as every other list here. Seeded from the 15 values actually in use.
- The settings list is a **FULL OUTER JOIN** of types-in-use against icons-configured, so
  a type someone adds tomorrow appears on its own, and an icon for a type no longer used
  is still visible to clean up.
- **`assets.profile_attachment_id`** — a *designation*, not a second copy. The file stays
  in `attachments`, linked as it already is; this only says which one is the face.
  Deleting the attachment nulls the pointer and the icon returns.
- `setAssetProfilePhoto` **refuses a photo not already attached to that asset**, so the
  pointer can't reference something the asset has no claim on.
- `getAssetFaces(ids)` is the bulk form: one query per list page, not one per row — with
  340 assets the per-row version would be the whole page's cost.

## Still to build on this branch

- Settings screen for editing icons.
- Face rendered in the asset header, asset lists and search results.
- "Use as profile photo" from an asset's existing attachments. The addendum asks for it
  in the audit runner too; the runner doesn't exist yet, so that hook lands with it.
