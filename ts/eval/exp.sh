#!/bin/sh
# 사용: sh eval/exp.sh '<옵션 JSON>' [trust]  → ios·android 를 동시에 돌려 한 줄씩 출력
cd "$(dirname "$0")/.."
npx tsx eval/experiment.ts ios "$1" $2 &
npx tsx eval/experiment.ts android "$1" $2 &
wait
