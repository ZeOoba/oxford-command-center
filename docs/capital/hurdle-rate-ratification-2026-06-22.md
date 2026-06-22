# ORA Hurdle Rate Ratification — 2026-06-22

**Ratified by:** Gabriel Goldberg, VP Acquisitions, Oxford Realty Advisors
**Date:** 2026-06-22
**Hurdle rate:** 8.0% unlevered IRR (decimal: 0.08)
**Ratification status:** proposed → ratified
**Capital config version:** 1
**DB record:** `capital_config.hurdle_rate_*` columns · oxford-command-center warehouse SQLite

Oxford Realty Advisors formally adopts 8.0% unlevered internal rate of return as
the minimum acceptable return threshold for capital allocation decisions. This value
supersedes the prior `proposed` state and is now the active hurdle rate governing
the Capital Allocation module. It may only be changed by re-invoking the
`ratify-hurdle-rate` skill and presenting Gabriel with an explicit confirmation block.
Modifying the underlying value without ratification is a CLAUDE.md §4 invariant breach.
