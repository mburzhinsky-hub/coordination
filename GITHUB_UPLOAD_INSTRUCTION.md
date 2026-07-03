# Как залить дашборд на GitHub и запустить

## 1. Распакуйте проект

Распакуйте архив `bitrix-task-control-dashboard.zip` в удобную папку.

## 2. Создайте приватный репозиторий

Рекомендуется создавать именно приватный репозиторий, потому что выгрузки Битрикс24 могут содержать ФИО, проекты, договоры и клиентские данные.

Название репозитория, например:

```text
bitrix-task-control-dashboard
```

## 3. Залейте проект через командную строку

Внутри папки проекта выполните:

```bash
git init
git add .
git commit -m "Initial Bitrix task dashboard"
git branch -M main
git remote add origin https://github.com/YOUR_LOGIN/bitrix-task-control-dashboard.git
git push -u origin main
```

Замените `YOUR_LOGIN` на ваш логин GitHub.

## 4. Проверка локального запуска

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python process_exports.py
streamlit run app.py
```

Для Windows активация окружения:

```powershell
.venv\Scripts\activate
```

## 5. Как прикладывать новые выгрузки

Кладите новые файлы в:

```text
data/raw/
```

Формат имени:

```text
tasks_YYYY-MM-DD_HH-MM.xls
```

Примеры:

```text
tasks_2026-07-03_09-00.xls
tasks_2026-07-03_14-00.xls
tasks_2026-07-04_09-00.xls
```

Старые файлы не удалять. Они нужны для динамики.

После добавления файла:

```bash
git add data/raw/tasks_YYYY-MM-DD_HH-MM.xls
git commit -m "Add Bitrix export YYYY-MM-DD HH-MM"
git push
```

## 6. Как часто обновлять

Обычный режим:

```text
1 раз в рабочий день утром, до 09:30.
```

Активная проектная фаза:

```text
2 раза в день: утром до 09:30 и после обеда в 14:00–15:00.
```

Критический период перед сдачей:

```text
3 раза в день: утром, в середине дня и в конце рабочего дня.
```

## 7. Деплой в Streamlit Community Cloud

1. Откройте Streamlit Community Cloud.
2. Нажмите `New app`.
3. Выберите GitHub-репозиторий.
4. В поле `Main file path` укажите:

```text
app.py
```

5. Нажмите `Deploy`.

Если реальные выгрузки не нужно хранить в GitHub, открывайте дашборд и загружайте свежий `.xls` через левую панель.

## 8. Автоматическая обработка

В проекте уже есть workflow:

```text
.github/workflows/process_exports.yml
```

Он запускается при изменении файлов в `data/raw/` и вручную через GitHub Actions.

Результаты обработки появляются как artifacts workflow и локально в папках:

```text
data/processed/
reports/
```
