#!/bin/bash
cd "$(dirname "$0")"
for seed in ${SEEDS:-7 11 23}; do
  VERSION=old SEED=$seed OUT=/tmp/eq_old_$seed.txt node spawn_equiv.js | tail -1
  VERSION=new SEED=$seed OUT=/tmp/eq_new_$seed.txt node spawn_equiv.js | tail -1
  if cmp -s /tmp/eq_old_$seed.txt /tmp/eq_new_$seed.txt; then echo "seed $seed IDENTICAL"; else echo "seed $seed DIFF"; diff /tmp/eq_old_$seed.txt /tmp/eq_new_$seed.txt | head -4 | cut -c1-400; fi
done
