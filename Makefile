VENV=.venv
PY=python3

.PHONY: setup run

setup:
	$(PY) -m venv $(VENV)
	. $(VENV)/bin/activate && python -m pip install --upgrade pip && pip install -r requirements.txt

run:
	if [ -z "$(IMG)" ]; then echo "Provide IMG=path/to/image.JPG"; exit 2; fi
	. $(VENV)/bin/activate && python main.py $(IMG) --json
