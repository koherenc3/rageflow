# Research

The cycle science this engine is built on, and where each modelling choice comes from. Every number in `src/engine/constants.ts` should trace back to something on this page.

## Cycles vary a lot, and they vary within one woman

The largest recent within-woman analysis reports variance over a single year of:

| Quantity         | Within-woman variance (days) | Median within-woman variability (days) |
| ---------------- | ---------------------------- | -------------------------------------- |
| Cycle length     | 10.3                         | 3.1                                    |
| Follicular phase | 11.2                         | 5.2                                    |
| Luteal phase     | 4.3                          | 3.0                                    |

Source: Human Reproduction, 2024. https://academic.oup.com/humrep/article/39/11/2565/7775370

Two things follow.

First, "her cycle is 28 days" is not a fact, it is a distribution. A tracker that shows a single confident date is misrepresenting the data it has. This is why every prediction the engine emits carries a 50% and an 80% credible interval, and why the point estimate is never presented on its own.

Second, the spread is large enough that a model has to be honest about how little it knows early on. A median within-woman variability of 3.1 days is the _best_ case, for a woman with regular cycles, measured with plenty of data. On two logged cycles you cannot distinguish her from someone at the wide end of the distribution.

## The luteal phase is not fixed at 14 days

The received wisdom is that the luteal phase is a constant 14 days and all cycle variation is follicular. The same 2024 Human Reproduction analysis shows luteal length varies both between women and from cycle to cycle within one woman: within-woman variance of 4.3 days, median variability of 3.0 days.

Consequence for the engine: luteal length is a **learned parameter with a prior**, not a constant. The prior is 13 days with a standard deviation of 2 days (`LUTEAL_PRIOR_MEAN_DAYS`, `LUTEAL_PRIOR_SD_DAYS`).

With start-date-only logging there is no observation that can update it, so it stays at the prior, and that is the honest answer. The update hook (`learnLutealLength(observations)`) exists now so that LH strips or basal body temperature could sharpen it later without rewriting anything. See [[DECISIONS]].

## Most variation is follicular, so predict backward from the next start

Because the follicular phase carries most of the cycle-to-cycle variation (variance 11.2 days versus 4.3 for luteal), the distance from the _last_ period start to ovulation is much less predictable than the distance from ovulation to the _next_ period start.

Two consequences, both implemented:

1. Predicting the next period start is a more tractable problem than predicting ovulation. The engine's primary output is the next start, and ovulation is derived from it: `estimatedOvulation = predictedNextStart - lutealLength`.
2. Anything premenstrual is indexed **backward from the predicted next start**, not forward from the last one. Counting "day 23 of a 28 day cycle" forward from the last start puts the premenstrual window in the wrong place for anyone whose current cycle runs long.

## Self-tracked data contains skipped cycles

Real logs from real people have gaps. A missed entry turns two cycles into one apparently very long one. Left in the data, a single 56 day gap in an otherwise 28 day history roughly triples the estimated variance, which widens every interval the app will ever show her.

Source: SkipTrack, https://arxiv.org/html/2508.05845

Consequence: skip detection is part of the model, not a UI afterthought. `src/engine/cycles.ts` flags a gap as a suspected missed log when it clears two independent gates, excludes it from the fit, and exposes the flag so the UI can ask her to confirm. The gates and their tuning are documented in `src/engine/constants.ts` and in [[TESTING]].

## Population cycle length, for the prior

The Normal-Inverse-Gamma prior over cycle length is `mu0 = 29`, `kappa0 = 1`, `alpha0 = 3`, `beta0 = 50`.

- `mu0 = 29` is the population central cycle length.
- `alpha0 = 3` with `beta0 = 50` gives a prior mean variance of `beta0 / (alpha0 - 1) = 25`, so a prior standard deviation of 5 days, matching the population spread.
- `kappa0 = 1` says the prior mean carries the weight of about one observed cycle, so her first real cycle already moves it.

Source: Apple Women's Health Study, npj Digital Medicine. https://www.nature.com/articles/s41746-023-00848-1

Pooled cohort data on cycle and phase lengths: https://pubmed.ncbi.nlm.nih.gov/32104920/

## Without temperature or LH, ovulation is inferred, not observed

This is the limit of what the app can honestly claim, and it is why every fertility output carries an explicit "estimate, not contraception" flag.

- Basal body temperature shows a clear biphasic curve in only about 70% of ovulatory cycles, and the shift appears 1 to 2 days **after** ovulation, so it confirms rather than predicts.
- Cervical mucus changes predict earlier than temperature does.
- With neither, the engine has only cycle length, so ovulation is a subtraction from a predicted date and inherits all of that prediction's uncertainty.

Sources:

- https://www.msdmanuals.com/professional/gynecology-and-obstetrics/family-planning/fertility-awareness-based-methods-of-contraception
- https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8238491/

The fertile window is set at five days before estimated ovulation through one day after, reflecting sperm survival of up to about five days in fertile cervical mucus and roughly a day of egg viability.

## Clinical thresholds

Cycles shorter than 21 days or longer than 45 days are outside the conventional typical range and are flagged as notable. The wording states the observation and suggests mentioning it to a doctor. It names no cause and no condition, because the engine has no way to know one and has no business guessing.

## Known limitations of the current model

- **Persistent shrinkage towards the prior.** Recency weighting caps the effective sample size at about `1 / (1 - 2^(-1/halfLife))`, which is roughly 9.2 cycles at a half life of 6. Because `kappa0 = 1`, the population prior keeps about 10% of the weight forever. For someone whose true cycle is 45 days, the point estimate settles about 1.5 days short of the truth rather than converging on it. This is the price of tracking drift, and it is visible in the long-cycle fixture. If it turns out to matter in practice, the fix is to let `kappa0` decay once enough of her own cycles exist, and that is a task 2 or later change.
- **Coverage is conservative for very regular cycles.** For a woman whose cycles vary by about a day, the prior's variance dominates for a long time and the 80% interval covers close to 100%. Being wider than claimed is a much smaller sin than being narrower, so this is accepted rather than tuned away. See [[TESTING]] for how the coverage property is actually asserted.
- **No ovulation observation.** Covered above. The luteal update hook is the intended route out.

## Related

- [[PLAN]] for the build phases.
- [[DECISIONS]] for the architectural choices and their reasoning.
- [[TESTING]] for how these claims are checked.
