"""dsh упал сам (не остановлен лаунчером): лаунчер перезапускает его и
показывает плашку «dsh перезапущен после сбоя»; падает снова и снова — после
трёх перезапусков за 10 минут останавливается и показывает страницу с журналом."""
import os

from helpers.env import FAKE, NOUPD
from helpers.procs import fakedsh_starts, wait_for
from helpers.windows import Toast

ONCE = '/tmp/crash-once'


def test_dsh_crash_restart(start, gui, drv):
    if os.path.exists(ONCE):
        os.remove(ONCE)
    launcher = start(FAKE, NOUPD, FAKE_CRASH_AFTER='2', FAKE_CRASH_ONCE=ONCE)
    gui.wait()
    assert launcher.wait_log('dsh упал (code=3, signal=null) — перезапускаю (1 за 10 минут)', 30), launcher.log()[-1500:]
    assert wait_for(lambda: fakedsh_starts() == 2, 30), 'dsh запущен заново'
    gui.wait()
    toast = Toast(drv).wait_shown('restarted after a crash', 30)
    assert 'exit code 3' in toast.text(), toast.text()
    launcher.term()


def test_dsh_crash_loop(start, gui):
    launcher = start(FAKE, NOUPD, FAKE_CRASH_AFTER='2')
    gui.wait()
    assert launcher.wait_log('dsh падает снова и снова — авто-перезапуск остановлен', 150), launcher.log()[-2000:]
    assert fakedsh_starts() == 4, f'первый запуск и три перезапуска: {fakedsh_starts()}'
    assert launcher.log().count('— перезапускаю (') == 3
    assert launcher.alive, 'лаунчер жив — показывает страницу с журналом'
    launcher.term()
