"""
krw.csv 환율 데이터 자동 갱신 스크립트
Frankfurter API (ECB 기반)에서 최신 USD/KRW 환율을 가져와 CSV에 추가한다.
GitHub Actions 크론으로 매일 자동 실행.
"""

import urllib.request
import json
import os
from datetime import datetime, timedelta

CSV_PATH = os.path.join(os.path.dirname(__file__), '..', 'krw', 'krw.csv')
API_BASE = 'https://api.frankfurter.dev/v1'


def get_csv_dates(csv_path):
    """CSV의 모든 날짜를 set으로 반환"""
    dates = set()
    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('기간'):
                continue
            date_str = line.split(',')[0].strip()
            dates.add(date_str)
    return dates


def get_last_csv_date(csv_path):
    """CSV 마지막 날짜 읽기"""
    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        lines = f.read().strip().split('\n')
    last_line = lines[-1].strip()
    date_str = last_line.split(',')[0].strip()
    return datetime.strptime(date_str, '%Y-%m-%d')


def fetch_rates(start_str, end_str):
    """Frankfurter API에서 환율 조회 (3개월 단위 분할)"""
    start = datetime.strptime(start_str, '%Y-%m-%d')
    end = datetime.strptime(end_str, '%Y-%m-%d')
    all_rates = {}

    cur = start
    while cur <= end:
        chunk_end = min(cur + timedelta(days=89), end)
        s = cur.strftime('%Y-%m-%d')
        e = chunk_end.strftime('%Y-%m-%d')
        url = f'{API_BASE}/{s}..{e}?base=USD&symbols=KRW'

        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'krw-csv-updater/1.0'})
            with urllib.request.urlopen(req, timeout=15) as res:
                data = json.loads(res.read().decode())
            rates = data.get('rates', {})
            all_rates.update(rates)
            print(f'  {s} ~ {e}: {len(rates)}건')
        except Exception as ex:
            print(f'  {s} ~ {e}: 실패 ({ex})')

        cur = chunk_end + timedelta(days=1)

    return all_rates


def append_to_csv(csv_path, rates):
    """새 환율 데이터를 CSV에 추가 (중복 방지)"""
    existing_dates = get_csv_dates(csv_path)
    sorted_dates = sorted(rates.keys())
    new_lines = []
    for d in sorted_dates:
        if d in existing_dates:
            continue
        rate = rates[d].get('KRW')
        if rate:
            new_lines.append(f'{d},{rate}')

    if new_lines:
        with open(csv_path, 'a', encoding='utf-8') as f:
            for line in new_lines:
                f.write('\n' + line)

    return new_lines


def main():
    csv_path = os.path.abspath(CSV_PATH)
    print(f'CSV: {csv_path}')

    last_date = get_last_csv_date(csv_path)
    print(f'마지막 날짜: {last_date.strftime("%Y-%m-%d")}')

    start = last_date + timedelta(days=1)
    today = datetime.now()

    if start > today:
        print('이미 최신 상태입니다.')
        return

    start_str = start.strftime('%Y-%m-%d')
    today_str = today.strftime('%Y-%m-%d')
    print(f'조회 범위: {start_str} ~ {today_str}')

    rates = fetch_rates(start_str, today_str)
    print(f'총 {len(rates)}건 조회')

    if not rates:
        print('추가할 데이터 없음')
        return

    new_lines = append_to_csv(csv_path, rates)
    print(f'CSV 추가 완료: {len(new_lines)}건')

    # 최종 확인
    new_last = get_last_csv_date(csv_path)
    print(f'CSV 최종 날짜: {new_last.strftime("%Y-%m-%d")}')


if __name__ == '__main__':
    main()
