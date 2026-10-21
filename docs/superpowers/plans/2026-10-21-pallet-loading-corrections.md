# Pallet loading corrections

**Goal:** Correct reviewed defaults/specifications and expose verifiable physical loading checks, with an immutable rollback release.

**Architecture:** Keep the existing geometric packer and 3D renderer. Improve mixed-carton ordering and pallet assignment; derive an independent loading assessment from the final physical blocks. Missing carton strength remains unknown, never guessed or certified safe. Preserve quantities and business data.

**Tech stack:** Existing plain JavaScript calculator, Node test runner and isolated Playwright fixtures.

**Spec:** `.superpowers/pallet-review-20261020/review.md`; user approved trying corrections with rollback.

- [ ] Add failing regression cases for default mass/upright rotation, zero tare, heavy-bottom ordering, top-load limits, final centre of mass, door checks and 40HC dimensions.
- [ ] Correct preset specifications using already reviewed carrier examples; show these as editable reference specifications including door dimensions.
- [ ] Expose pallet tare/deck and carton allowable top load. Preserve existing explicit rotation choices and extend CSV roundtrip for constraints.
- [ ] Prioritize heavier cartons at the bottom; balance equal-footprint pallet positions. Keep independent no-overlap/full-support tests.
- [ ] Assess the final layout: carton loads distributed by contact area through supporting cartons, payload, door passage and CG. State uniform contact-pressure assumption. Unknown strength or vehicle handling restrictions must stay pending. Bound individual-carton expansion for browser performance.
- [ ] Render counts, loading assessment and readable pallet cards separately. A geometric fit is not approval for transport. Suppress recommendations for rejected/pending loading checks.
- [ ] Run existing/full regression and browser tests, exact screenshot fixtures and review the diff.
- [ ] Commit and push a new branch; stage immutable image, backup/restore, promote and verify production. Record previous image and rollback instruction.

Review focus: duplicate colours must not confuse mass attribution; explicit zero allowable top load means nothing above; unknown weights cannot appear verified; CSV must preserve all constraints and empty values; long product names must wrap inside pallet cards.
