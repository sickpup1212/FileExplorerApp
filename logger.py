import logging
import logging.config
import sys

def setup_logging():
    logging.config.dictConfig({
        'version': 1,
        'disable_existing_loggers': False,
        'formatters': {
            'json': {
                '()': 'pythonjsonlogger.jsonlogger.JsonFormatter',
                'format': '%(asctime)s %(name)s %(levelname)s %(message)s'
            },
        },
        'handlers': {
            'stdout': {
                'level': 'INFO',
                'class': 'logging.StreamHandler',
                'stream': sys.stdout,
                'formatter': 'json'
            },
        },
        'loggers': {
            '': {
                'handlers': ['stdout'],
                'level': 'INFO',
                'propagate': True
            }
        }
    })
