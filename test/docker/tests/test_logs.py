"""Журнал лаунчера (launcher.log рядом с dsh.log): сообщения лаунчера со
временем, без строк dsh и без токенов; ротация после 2 МБ."""
import os
import re

from helpers.env import FAKE, NOUPD, STATE
from helpers.procs import as_tester, wait_for

LOG = f'{STATE}/launcher.log'


def read(path):
    with open(path, encoding='utf-8', errors='replace') as f:
        return f.read()


def test_launcher_log(start, gui):
    launcher = start(FAKE, NOUPD)
    gui.wait()
    launcher.term()

    text = read(LOG)
    assert re.search(r'===== DeepSeek Harness Launcher \S+, pid \d+, ', text), 'заголовок запуска'
    assert re.search(r'^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} \[launcher\] окно показано$', text, re.M), 'строки со временем'
    assert '[launcher] starting: /opt/t/fakes/fakedsh.py' in text
    assert '[launcher] SIGTERM' in text, 'и остановка'
    # фейковый dsh печатает «dsh web: …?token=abc»: строки dsh — только в dsh.log
    assert '[dsh]' not in text, 'строк dsh в журнале лаунчера нет'
    assert 'token=abc' in read(f'{STATE}/dsh.log'), 'они — в dsh.log'
    assert 'token=abc' not in text, 'токен скрыт'


def test_launcher_log_rotate(start, gui):
    as_tester(f"mkdir -p {STATE} && head -c 2200000 /dev/zero | tr '\\0' x > {LOG}")
    launcher = start(FAKE, NOUPD)
    gui.wait()
    launcher.term()

    assert os.path.getsize(f'{LOG}.1') >= 2200000, 'большой журнал сдвинут в launcher.log.1'
    text = read(LOG)
    assert 'лог прокручен: launcher.log (2200000 Б) -> launcher.log.1' in text, text[:500]
    assert os.path.getsize(LOG) < 100000, 'новый журнал — с начала'


def test_log_rotate_while_running(start, gui):
    """Ротация и во время работы, а не только при запуске: на каждый журнал —
    не больше двух файлов (*.log и *.log.1), каждый не больше порога."""
    max_bytes = 800  # за сеанс лаунчер пишет ~2 КБ — журнал лаунчера тоже прокрутится
    launcher = start(FAKE, NOUPD, DSH_LAUNCHER_LOG_MAX_BYTES=str(max_bytes), FAKE_SPAM_LINES='500')
    gui.wait()
    assert wait_for(lambda: 'spam line 00499' in read(f'{STATE}/dsh.log'), 30), 'dsh допечатал'
    launcher.term()

    logs = sorted(n for n in os.listdir(STATE) if '.log' in n)  # кроме, например, маркера GPU
    assert logs == ['dsh.log', 'dsh.log.1', 'launcher.log', 'launcher.log.1'], logs
    for name in logs:
        # ротация — до записи: ни один файл не больше порога
        assert os.path.getsize(f'{STATE}/{name}') <= max_bytes, f'{name}: {os.path.getsize(f"{STATE}/{name}")} Б'
    assert 'spam line 00499' in read(f'{STATE}/dsh.log'), 'последние строки dsh — в новом файле'
