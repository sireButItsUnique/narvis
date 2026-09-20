#include <stdio.h>
#include "util.h"

int total(int x) {
  return add(x, 1);
}

int main() {
  printf("%d", total(2));
  return 0;
}
